-- 0012_event_config_and_switches.sql
--
-- Feature A (branding, AR/EN locale, draft -> live -> archived), feature G's five control
-- switches, feature D's spend cap in money rather than counts, and feature H's guest mode.
--
-- Law 5 is the spine of this migration: every one of these is a COLUMN ON events. There is no
-- settings table without an event_id, no global toggle, and no config file that could reach
-- two events at once. Flipping a switch on one event cannot touch another because the switch
-- does not exist anywhere except on that row.
--
-- The switches are ENFORCED, not displayed. A paused intake refuses the insert; a paused AI
-- refuses the enqueue; a frozen wall stops advancing; panic mode empties the wall. Hiding a
-- button is not a control, because the button is not the only way in.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

/* ------------------------------------------------------------------- bilingual, first class */

alter table events
  add column locale_default text not null default 'ar' check (locale_default in ('ar', 'en')),
  add column locales text[] not null default array['ar', 'en']
    check (locales <@ array['ar', 'en'] and array_length(locales, 1) >= 1),
  add column name_ar text,
  add column name_en text;

comment on column events.locales is
  'Which languages this event runs in. Bilingual AR/EN is first class, so this is per-event, never global.';

/* ------------------------------------------------------------------------------- branding (A) */

alter table events
  add column brand_primary        text not null default '#111111'
    check (brand_primary ~ '^#[0-9a-fA-F]{6}$'),
  add column brand_secondary      text not null default '#f5f5f5'
    check (brand_secondary ~ '^#[0-9a-fA-F]{6}$'),
  add column brand_logo_path      text,
  add column brand_wordmark_path  text,
  add column brand_font_family    text;

/* --------------------------------------------------------- status: draft -> live -> archived
 * The approved feature list says archived. The schema said 'ended', which is not a word in the
 * feature list, and nothing stopped a status jumping straight backwards.
 */

alter table events drop constraint events_status_check;
alter table events add constraint events_status_check
  check (status in ('draft', 'live', 'archived'));

create or replace function events_guard_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    -- draft -> live -> archived, and draft -> archived to cancel something never run.
    -- Nothing returns from archived, and nothing goes backwards from live.
    if not (
      (old.status = 'draft' and new.status in ('live', 'archived')) or
      (old.status = 'live'  and new.status = 'archived')
    ) then
      raise exception 'ILLEGAL_STATUS_TRANSITION'
        using hint = format('An event cannot go from %s to %s.', old.status, new.status);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists events_guard_status on events;
create trigger events_guard_status
  before update on events
  for each row
  execute function events_guard_status();

/* ---------------------------------------------------------------- the guest mode (feature H) */

alter table events
  add column guest_mode text not null default 'wall_only'
    check (guest_mode in ('wall_only', 'code_per_shot', 'registration'));

/* ------------------------------------------------------- the five control switches (feature G)
 * Per-event columns, so law 5 holds by construction. wall_frozen_at is a timestamp rather than
 * a boolean because a freeze has to mean "the wall keeps showing what it had", which requires
 * knowing the moment it froze.
 */

alter table events
  add column wall_frozen        boolean not null default false,
  add column wall_frozen_at     timestamptz,
  add column panic_brand_only   boolean not null default false,
  add column intake_paused      boolean not null default false,
  add column ai_paused          boolean not null default false,
  add column banner_active      boolean not null default false,
  add column banner_text_en     text,
  add column banner_text_ar     text;

comment on column events.wall_frozen_at is
  'Set when the wall is frozen. wall_photos will not return anything captured after this instant.';

/* ------------------------------------------------------------- the spend cap in money (D)
 * The old cap counted generations. The feature list says "spend cap consumed before the paid
 * call, cost logged", and a model price change turns a count into a number that means nothing.
 * Both caps now apply, and both are consumed in the same atomic statement.
 */

alter table events
  add column ai_budget_usd numeric(10, 2) check (ai_budget_usd is null or ai_budget_usd >= 0),
  add column ai_spend_usd  numeric(12, 4) not null default 0 check (ai_spend_usd >= 0),
  add column ai_allowed_models text[] not null default array['google/gemini-3.1-flash-image'];

comment on column events.ai_budget_usd is
  'Dollar ceiling for this event. NULL means no dollar ceiling; the generation count cap still applies.';

drop function if exists consume_generation(uuid);

create function consume_generation(p_event_id uuid, p_estimated_cost_usd numeric default 0)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ok boolean;
  v_est numeric := greatest(0, coalesce(p_estimated_cost_usd, 0));
begin
  -- One statement is the whole budget, so two workers cannot both pass the check. The spend
  -- is taken BEFORE the paid call, which is what the feature list asks for: an event can
  -- finish under budget having refused work, but it cannot finish over budget having done it.
  update events
     set generations_used = generations_used + 1,
         ai_spend_usd     = ai_spend_usd + v_est,
         updated_at       = now()
   where id = p_event_id
     and ai_paused = false
     and generations_used < max_generations
     and (ai_budget_usd is null or ai_spend_usd + v_est <= ai_budget_usd)
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

comment on function consume_generation(uuid, numeric) is
  'INV-4: count cap and dollar cap consumed in one atomic statement, before the paid call. Also refuses while AI is paused.';

create or replace function settle_generation(
  p_event_id uuid,
  p_estimated_cost_usd numeric,
  p_actual_cost_usd numeric
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  -- consume_generation already booked the ESTIMATE before the paid call. This releases that
  -- reservation and books what the call actually cost, so the meter reads money spent rather
  -- than money reserved. Adding the actual cost without releasing the estimate would count
  -- every generation twice. Never drops below zero.
  update events
     set ai_spend_usd = greatest(0, ai_spend_usd
                                    - greatest(0, coalesce(p_estimated_cost_usd, 0))
                                    + greatest(0, coalesce(p_actual_cost_usd, 0))),
         updated_at = now()
   where id = p_event_id;
$$;

comment on function settle_generation(uuid, numeric, numeric) is
  'Call after the paid call returns: swaps the reserved estimate for the real cost. The cap is never raised, only reconciled.';

/* ---------------------------------------------------- the switches actually stop things (G)
 * Each of these raises a named error the API layer can translate. A paused intake that only
 * greys out a button is not paused, because the button is not the only way in.
 */

create or replace function api_upsert_photo_if_absent(
  p_photo_id uuid,
  p_event_id uuid,
  p_operator_id uuid,
  p_kind text,
  p_storage_path text,
  p_thumb_path text,
  p_bytes integer
)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_paused boolean;
begin
  select intake_paused into v_paused from events where id = p_event_id;
  if v_paused is null then
    raise exception 'UNKNOWN_EVENT' using hint = 'No event with that id.';
  end if;
  if v_paused then
    raise exception 'INTAKE_PAUSED'
      using hint = 'Capture is paused for this event from the control room.';
  end if;

  -- Idempotent by client-minted id: a retried upload from an offline outbox cannot become a
  -- second photo. This is the foundation law 1 is built on in Phase 1.
  return query
    insert into photos (id, event_id, operator_id, kind, storage_path, thumb_path, bytes, status)
    values (p_photo_id, p_event_id, p_operator_id, p_kind, p_storage_path, p_thumb_path,
            p_bytes, 'processing')
    on conflict (id) do nothing
    returning *;

  if not found then
    return query select * from photos where id = p_photo_id;
  end if;
end;
$$;

create or replace function api_enqueue_job(p_event_id uuid, p_photo_id uuid, p_operator_id uuid)
returns setof ai_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_paused boolean;
begin
  select ai_paused into v_paused from events where id = p_event_id;
  if v_paused is null then
    raise exception 'UNKNOWN_EVENT' using hint = 'No event with that id.';
  end if;
  if v_paused then
    raise exception 'AI_PAUSED'
      using hint = 'Generation is paused for this event from the control room.';
  end if;

  return query
    insert into ai_jobs (event_id, photo_id, operator_id, status)
    values (p_event_id, p_photo_id, p_operator_id, 'queued')
    returning *;
end;
$$;

/* --------------------------------------------------- the wall obeys the switches (F, G, 7)
 * Still thumbnails only - storage_path is not in the return type, so law 7 stays dead. What
 * changes is that a frozen wall stops advancing and panic mode empties it, both decided in
 * the database rather than by a client that might not have heard.
 */

drop function if exists wall_photos(text, integer);

create function wall_photos(p_event_slug text, p_limit integer default 24)
returns table (
  id uuid,
  kind text,
  thumb_path text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.kind, p.thumb_path, p.created_at
    from photos p
    join events e on e.id = p.event_id
   where e.slug = p_event_slug
     and p.approved = true
     and p.status = 'ready'
     and e.panic_brand_only = false
     and (e.wall_frozen = false or p.created_at <= coalesce(e.wall_frozen_at, now()))
   order by p.created_at desc
   limit greatest(1, least(coalesce(p_limit, 24), 60));
$$;

comment on function wall_photos(text, integer) is
  'INV-1: the wall gate. approved AND ready, thumbnails only, and obedient to freeze and panic. There is no path from here to an original.';

/* -------------------------------------------------------- setting the switches, always audited */

create or replace function api_set_event_switches(
  p_event_id        uuid,
  p_wall_frozen     boolean default null,
  p_panic_brand_only boolean default null,
  p_intake_paused   boolean default null,
  p_ai_paused       boolean default null,
  p_banner_active   boolean default null,
  p_banner_text_en  text default null,
  p_banner_text_ar  text default null,
  p_operator_id     uuid default null,
  p_admin_id        uuid default null
)
returns setof events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before events;
  v_after  events;
  v_label  text := 'system';
  v_kind   text := 'system';
begin
  select * into v_before from events where id = p_event_id;
  if not found then
    raise exception 'UNKNOWN_EVENT' using hint = 'No event with that id.';
  end if;

  update events
     set wall_frozen      = coalesce(p_wall_frozen, wall_frozen),
         wall_frozen_at   = case
                              when p_wall_frozen is null then wall_frozen_at
                              when p_wall_frozen then coalesce(wall_frozen_at, now())
                              else null
                            end,
         panic_brand_only = coalesce(p_panic_brand_only, panic_brand_only),
         intake_paused    = coalesce(p_intake_paused, intake_paused),
         ai_paused        = coalesce(p_ai_paused, ai_paused),
         banner_active    = coalesce(p_banner_active, banner_active),
         banner_text_en   = coalesce(p_banner_text_en, banner_text_en),
         banner_text_ar   = coalesce(p_banner_text_ar, banner_text_ar),
         updated_at       = now()
   where id = p_event_id
  returning * into v_after;

  if p_admin_id is not null then
    select ad.username || ' (admin)' into v_label from admins ad where ad.id = p_admin_id;
    v_kind := 'admin';
  elsif p_operator_id is not null then
    select o.username || ' (' || o.role || ')' into v_label from operators o where o.id = p_operator_id;
    v_kind := 'operator';
  end if;

  insert into audit_log (event_id, actor_kind, actor_operator_id, actor_label,
                         action, target_kind, target_id, before, after, reason)
  values (p_event_id, v_kind, p_operator_id, coalesce(v_label, 'system'),
          'set_switches', 'event', p_event_id,
          jsonb_build_object('wallFrozen', v_before.wall_frozen,
                             'panicBrandOnly', v_before.panic_brand_only,
                             'intakePaused', v_before.intake_paused,
                             'aiPaused', v_before.ai_paused,
                             'bannerActive', v_before.banner_active),
          jsonb_build_object('wallFrozen', v_after.wall_frozen,
                             'panicBrandOnly', v_after.panic_brand_only,
                             'intakePaused', v_after.intake_paused,
                             'aiPaused', v_after.ai_paused,
                             'bannerActive', v_after.banner_active),
          'control room');

  return next v_after;
end;
$$;

create or replace function api_set_event_branding(
  p_event_id uuid,
  p_name_en text default null,
  p_name_ar text default null,
  p_locale_default text default null,
  p_locales text[] default null,
  p_brand_primary text default null,
  p_brand_secondary text default null,
  p_brand_logo_path text default null,
  p_brand_wordmark_path text default null,
  p_brand_font_family text default null,
  p_guest_mode text default null
)
returns setof events
language sql
security definer
set search_path = public, pg_temp
as $$
  update events
     set name_en              = coalesce(p_name_en, name_en),
         name_ar              = coalesce(p_name_ar, name_ar),
         locale_default       = coalesce(p_locale_default, locale_default),
         locales              = coalesce(p_locales, locales),
         brand_primary        = coalesce(p_brand_primary, brand_primary),
         brand_secondary      = coalesce(p_brand_secondary, brand_secondary),
         brand_logo_path      = coalesce(p_brand_logo_path, brand_logo_path),
         brand_wordmark_path  = coalesce(p_brand_wordmark_path, brand_wordmark_path),
         brand_font_family    = coalesce(p_brand_font_family, brand_font_family),
         guest_mode           = coalesce(p_guest_mode, guest_mode),
         updated_at           = now()
   where id = p_event_id
  returning *;
$$;

select apply_function_grants();

do $$
declare v_count integer;
begin
  select count(*) into v_count from assert_schema_locked();
  if v_count > 0 then
    raise exception 'schema lock assertion failed with % violation(s) after 0012', v_count;
  end if;
end
$$;
