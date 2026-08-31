-- 0032_moderation_scope_and_caps.sql
--
-- Four defects the post-freeze audit found, in the order they would cost a live event.
--
--   NO DOLLAR CEILING BY DEFAULT. consume_generation guards with `ai_budget_usd is null or
--   ...`, and api_create_event inserts only slug and name - so every event ever created shipped
--   with no dollar cap at all, and both live events had one of NULL. The only ceiling was the
--   generation count. Law 4's spend cap is only a cap if it exists by default, so the column
--   becomes NOT NULL with a default, and existing nulls are backfilled from what the count cap
--   already implied.
--
--   FOUR MODERATION VERBS COULD REACH ACROSS EVENTS. unapprove, hide, reject and delete select
--   `from photos where id = p_photo_id` with no event predicate. An operator's session names
--   their event, so the API could not be talked into it - but law 5 is meant to hold in the
--   database, not in the caller. Every moderation verb now resolves the actor's scope and
--   refuses a photo outside it.
--
--   AN ADMIN COULD NOT MODERATE ANYTHING. Feature E says "admin sees all, overrides anything,
--   every override logged". Every moderation action required an operator session, the functions
--   took a non-optional operator id, and audit_log's 'admin' actor_kind was unwritable until
--   0031. All seven verbs now accept an admin, and attribute the override to them.
--
--   REGISTRATION THROTTLED AT ROUGHLY TWO GUESTS A MINUTE. The limit is charged per client,
--   and a kiosk is one client for every guest who uses it, so ten registrations in five minutes
--   was the ceiling for the whole station. Raised to an event-realistic rate.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

/* ------------------------------------------------------- (a) no event without a dollar cap */

update events
   set ai_budget_usd = round(least(coalesce(max_generations, 1000)::numeric
                                   * coalesce(ai_est_cost_usd, 0.04), 25.00), 2)
 where ai_budget_usd is null;

alter table events alter column ai_budget_usd set default 25.00;
alter table events alter column ai_budget_usd set not null;

comment on column events.ai_budget_usd is
  'Dollar ceiling for this event. NOT NULL: an event with no ceiling is how an unattended job runner spends real money, so there is no way to create one. Change it in the admin AI panel.';

/* ------------------------------------------- (b) + (c) one scope rule for every moderation verb */

-- Who is allowed to touch this photo, and is it theirs? An operator is confined to their own
-- event; an admin sees all, which is feature E's promise. Returns the event so the caller does
-- not re-read it.
create or replace function moderation_scope(
  p_photo photos, p_operator_id uuid, p_admin_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_event uuid;
begin
  if p_admin_id is not null then
    if not exists (select 1 from admins a where a.id = p_admin_id and a.active) then
      raise exception 'UNKNOWN_ADMIN' using hint = 'No active admin with that id.';
    end if;
    return p_photo.event_id;               -- an admin overrides anything, on any event
  end if;

  if p_operator_id is null then
    raise exception 'MODERATOR_REQUIRED'
      using hint = 'Moderation needs either an operator or an admin.';
  end if;

  select o.event_id into v_event
    from operators o where o.id = p_operator_id and o.active;
  if v_event is null then
    raise exception 'UNKNOWN_OPERATOR' using hint = 'No active operator with that id.';
  end if;
  if v_event <> p_photo.event_id then
    raise exception 'WRONG_EVENT'
      using hint = 'That photo belongs to a different event.';
  end if;
  return v_event;
end;
$$;

comment on function moderation_scope(photos, uuid, uuid) is
  'Law 5 in the database rather than in the caller: an operator may only moderate inside their own event. Feature E: an admin may moderate anywhere.';

-- Routes an override to the right half of the audit trail. Both halves are deliberately not
-- exception-safe: losing the record of an override is not acceptable.
create or replace function log_moderation(
  p_event_id uuid, p_operator_id uuid, p_admin_id uuid,
  p_action text, p_target_id uuid,
  p_before jsonb default null, p_after jsonb default null, p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_admin_id is not null then
    perform log_override_admin(p_event_id, p_admin_id, p_action, 'photo', p_target_id,
                               p_before, p_after, p_reason);
  else
    perform log_override(p_event_id, p_operator_id, p_action, 'photo', p_target_id,
                         p_before, p_after, p_reason);
  end if;
end;
$$;

-- The old arities are dropped rather than overloaded: an added parameter with a default would
-- make every existing two-argument call ambiguous against the old two-argument function.
drop function if exists approve_photo(uuid, uuid);
drop function if exists unapprove_photo(uuid, uuid);
drop function if exists api_hide_photo(uuid, uuid);
drop function if exists api_unhide_photo(uuid, uuid);
drop function if exists api_use_original(uuid, uuid);
drop function if exists api_reject_photo(uuid, uuid, text);
drop function if exists api_delete_photo(uuid, uuid, text);

create function approve_photo(p_photo_id uuid, p_operator_id uuid, p_admin_id uuid default null)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_photo photos; v_event uuid;
begin
  select * into v_photo from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;
  v_event := moderation_scope(v_photo, p_operator_id, p_admin_id);

  if v_photo.status <> 'ready' then
    raise exception 'PHOTO_NOT_READY'
      using hint = 'A photo can only be approved once its upload is confirmed (status = ready).';
  end if;

  if v_photo.kind = 'generated'
     and not exists (
       select 1 from ai_jobs j
        where j.result_photo_id = v_photo.id
          and j.status = 'done'
     ) then
    raise exception 'GENERATION_NOT_DONE'
      using hint = 'Wait for the generation to finish before approving the result.';
  end if;

  perform log_moderation(v_event, p_operator_id, p_admin_id, 'approve', p_photo_id,
                         jsonb_build_object('approved', v_photo.approved),
                         jsonb_build_object('approved', true, 'kind', v_photo.kind));

  -- approved_by stays null for an admin: the column carries a composite foreign key into
  -- operators, and the audit trail is where an admin's name belongs.
  return query
    update photos
       set approved = true,
           approved_by = p_operator_id,
           approved_at = now()
     where id = p_photo_id
    returning *;
end;
$$;

create function unapprove_photo(p_photo_id uuid, p_operator_id uuid, p_admin_id uuid default null)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_photo photos; v_event uuid;
begin
  select * into v_photo from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;
  v_event := moderation_scope(v_photo, p_operator_id, p_admin_id);

  perform log_moderation(v_event, p_operator_id, p_admin_id, 'unapprove', p_photo_id,
                         jsonb_build_object('approved', v_photo.approved,
                                            'approvedBy', v_photo.approved_by),
                         jsonb_build_object('approved', false));

  return query
    update photos
       set approved = false, approved_by = null, approved_at = null
     where id = p_photo_id
    returning *;
end;
$$;

create function api_hide_photo(p_photo_id uuid, p_operator_id uuid, p_admin_id uuid default null)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_photo photos; v_event uuid;
begin
  select * into v_photo from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;
  v_event := moderation_scope(v_photo, p_operator_id, p_admin_id);

  perform log_moderation(v_event, p_operator_id, p_admin_id, 'hide', p_photo_id,
                         jsonb_build_object('status', v_photo.status, 'approved', v_photo.approved),
                         jsonb_build_object('status', 'hidden', 'approved', false));

  return query
    update photos
       set status = 'hidden', approved = false, approved_by = null, approved_at = null
     where id = p_photo_id
    returning *;
end;
$$;

create function api_unhide_photo(p_photo_id uuid, p_operator_id uuid, p_admin_id uuid default null)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_photo photos; v_event uuid;
begin
  select * into v_photo from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;
  v_event := moderation_scope(v_photo, p_operator_id, p_admin_id);

  perform log_moderation(v_event, p_operator_id, p_admin_id, 'unhide', p_photo_id,
                         jsonb_build_object('status', v_photo.status),
                         jsonb_build_object('status', 'ready'));

  update photos set status = 'ready' where id = p_photo_id and status = 'hidden';

  return query select * from photos where id = p_photo_id;
end;
$$;

create function api_reject_photo(p_photo_id uuid, p_operator_id uuid, p_reason text default null,
                                 p_admin_id uuid default null)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_photo photos; v_event uuid;
begin
  select * into v_photo from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;
  v_event := moderation_scope(v_photo, p_operator_id, p_admin_id);

  perform log_moderation(v_event, p_operator_id, p_admin_id, 'reject', p_photo_id,
                         jsonb_build_object('status', v_photo.status, 'approved', v_photo.approved),
                         jsonb_build_object('status', 'rejected'), p_reason);

  return query
    update photos
       set status = 'rejected', approved = false, approved_by = null, approved_at = null,
           rejected_reason = p_reason
     where id = p_photo_id
    returning *;
end;
$$;

create function api_delete_photo(p_photo_id uuid, p_operator_id uuid, p_reason text default null,
                                 p_admin_id uuid default null)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_photo photos; v_event uuid;
begin
  select * into v_photo from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;
  v_event := moderation_scope(v_photo, p_operator_id, p_admin_id);

  perform log_moderation(v_event, p_operator_id, p_admin_id, 'delete', p_photo_id,
                         jsonb_build_object('status', v_photo.status, 'approved', v_photo.approved),
                         jsonb_build_object('status', 'deleted'), p_reason);

  -- A soft delete. The row survives so the audit trail still points at something real, and so
  -- the storage object can be reclaimed deliberately rather than orphaned.
  return query
    update photos
       set status = 'deleted', approved = false, approved_by = null, approved_at = null,
           deleted_at = now()
     where id = p_photo_id
    returning *;
end;
$$;

create function api_use_original(p_photo_id uuid, p_operator_id uuid, p_admin_id uuid default null)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_photo photos; v_event uuid; v_source uuid;
begin
  select * into v_photo from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;
  v_event := moderation_scope(v_photo, p_operator_id, p_admin_id);

  if v_photo.source_photo_id is null then
    raise exception 'NO_ORIGINAL' using hint = 'This photo is not a generated derivative of anything.';
  end if;
  v_source := v_photo.source_photo_id;

  perform log_moderation(v_event, p_operator_id, p_admin_id, 'use_original', p_photo_id,
                         jsonb_build_object('generated', p_photo_id),
                         jsonb_build_object('original', v_source));

  -- The restyle steps aside and the original is published in its place.
  update photos set use_original = true, approved = false, approved_by = null, approved_at = null
   where id = p_photo_id;

  return query
    update photos
       set approved = true, approved_by = p_operator_id, approved_at = now()
     where id = v_source
    returning *;
end;
$$;

/* --------------------------------------------- (d) a registration limit an event can live with */

create or replace function api_register_guest(
  p_event_id     uuid,
  p_display_name text default null,
  p_phone        text default null,
  p_email        text default null,
  p_locale       text default 'ar',
  p_consent      boolean default false,
  p_retain_days  integer default 90,
  p_client       text default 'unknown',
  p_limit        integer default 60
)
returns table (outcome text, guest_id uuid, code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode     text;
  v_attempts integer;
  v_guest    uuid;
  v_code     record;
begin
  -- Charged BEFORE anything is written or revealed, per client, exactly as the lookup is.
  -- Law 12: the counter is a row, so a restart forgives nothing.
  --
  -- The ceiling is 60 in five minutes rather than 10, because the client this is charged to is
  -- an iPad, not a person: every guest who walks up to one kiosk shares a single subject, so a
  -- limit meant to stop one attacker was throttling a whole station to two guests a minute. The
  -- limit still bounds abuse; it no longer bounds the event.
  v_attempts := consume_platform_rate_limit('guest_register',
                  coalesce(nullif(btrim(p_client), ''), 'unknown'), 300);
  if v_attempts > greatest(1, p_limit) then
    return query select 'rate_limited'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  select e.guest_mode into v_mode from events e where e.id = p_event_id;
  if v_mode is null then
    return query select 'not_found'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;
  if v_mode <> 'registration' then
    return query select 'mode_refused'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  insert into guests (event_id, display_name, phone, email, locale, consent_at, retain_until)
  values (p_event_id, p_display_name, p_phone, p_email, coalesce(p_locale, 'ar'),
          case when p_consent then now() else null end,
          now() + make_interval(days => greatest(1, p_retain_days)))
  returning id into v_guest;

  select * into v_code from api_mint_guest_code(p_event_id, null, v_guest, null, 720);
  return query select 'ok'::text, v_guest, v_code.code, v_code.expires_at;
end;
$$;

/* --------------------------------------------------------------------- the gate for all four */

create or replace function gate_moderation_scope()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  a uuid; b uuid; opA uuid; opB uuid; adm uuid; ph uuid; phb uuid;
  n integer; t text; ok boolean; i integer;
  v_client text := 'gate-reg-' || gen_random_uuid();
begin
  perform gate_cleanup();

  insert into events (slug, name, status) values ('gate-mod-a', 'Gate Mod A', 'live') returning id into a;
  insert into events (slug, name, status, guest_mode)
  values ('gate-mod-b', 'Gate Mod B', 'live', 'registration') returning id into b;
  select id into opA from api_create_operator(a, 'gatemoda', 'Gate Mod A', 'A', 'operator', '111111');
  select id into opB from api_create_operator(b, 'gatemodb', 'Gate Mod B', 'A', 'operator', '222222');
  select id into adm from api_create_admin('gateadmin-mod', 'Gate Mod Admin', 'gate-password-2');

  /* ---------------------------------------------------- (a) no event ships without a ceiling */

  area := 'law 4'; check_name := 'a brand-new event has a dollar ceiling, not just a count cap';
  select count(*) into n from events where id in (a, b) and ai_budget_usd is not null;
  expected := '2'; actual := n::text; pass := (n = 2); return next;

  area := 'law 4'; check_name := 'and no event anywhere can be left without one';
  select count(*) into n
    from information_schema.columns
   where table_name = 'events' and column_name = 'ai_budget_usd' and is_nullable = 'NO';
  expected := '1 (NOT NULL)'; actual := n::text; pass := (n = 1); return next;

  /* -------------------------------------------- (b) + (c) scope, and an admin who can act */

  ph := gen_random_uuid();
  perform api_upsert_photo_if_absent(ph, a, opA, 'original', 'o/m1.jpg', 't/m1.jpg', 10,
                                     'gate-mod-dev', now(), 'booth', 'straight', null, null);
  perform api_confirm_photo(ph);

  area := 'law 5'; check_name := 'an operator cannot delete a photo belonging to another event';
  begin
    perform api_delete_photo(ph, opB, 'gate', null);
    t := 'DELETED';
  exception when others then t := sqlerrm;
  end;
  expected := 'WRONG_EVENT'; actual := t; pass := (t = 'WRONG_EVENT'); return next;

  area := 'law 5'; check_name := 'nor hide one';
  begin
    perform api_hide_photo(ph, opB, null);
    t := 'HIDDEN';
  exception when others then t := sqlerrm;
  end;
  expected := 'WRONG_EVENT'; actual := t; pass := (t = 'WRONG_EVENT'); return next;

  area := 'law 5'; check_name := 'nor reject one';
  begin
    perform api_reject_photo(ph, opB, 'gate', null);
    t := 'REJECTED';
  exception when others then t := sqlerrm;
  end;
  expected := 'WRONG_EVENT'; actual := t; pass := (t = 'WRONG_EVENT'); return next;

  area := 'law 5'; check_name := 'and the photo is untouched by any of it';
  select status into t from photos where id = ph;
  expected := 'ready'; actual := t; pass := (t = 'ready'); return next;

  area := 'feature E'; check_name := 'an admin CAN approve, on an event they were never assigned';
  perform approve_photo(ph, null, adm);
  select approved into ok from photos where id = ph;
  expected := 'true'; actual := coalesce(ok::text, '(none)'); pass := (ok is true); return next;

  area := 'feature E'; check_name := 'and the override is logged against the admin, by name';
  select count(*) into n from audit_log
   where event_id = a and action = 'approve' and actor_kind = 'admin'
     and actor_label like 'gateadmin-mod%';
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  area := 'feature E'; check_name := 'an admin approval leaves approved_by null, not a fake operator';
  select (approved_by is null) into ok from photos where id = ph;
  expected := 'true'; actual := coalesce(ok::text, '(none)'); pass := (ok is true); return next;

  area := 'law 5'; check_name := 'moderation with neither an operator nor an admin is refused';
  begin
    perform api_hide_photo(ph, null, null);
    t := 'ALLOWED';
  exception when others then t := sqlerrm;
  end;
  expected := 'MODERATOR_REQUIRED'; actual := t; pass := (t = 'MODERATOR_REQUIRED'); return next;

  area := 'law 6'; check_name := 'a deactivated operator cannot moderate either';
  perform api_set_operator_active(opA, false, adm);
  begin
    perform api_hide_photo(ph, opA, null);
    t := 'ALLOWED';
  exception when others then t := sqlerrm;
  end;
  expected := 'UNKNOWN_OPERATOR'; actual := t; pass := (t = 'UNKNOWN_OPERATOR'); return next;
  perform api_set_operator_active(opA, true, adm);

  area := 'feature E'; check_name := 'hide is not a one-way door: unhide restores the photo';
  perform api_hide_photo(ph, opA, null);
  perform api_unhide_photo(ph, opA, null);
  select status into t from photos where id = ph;
  expected := 'ready'; actual := t; pass := (t = 'ready'); return next;

  /* --------------------------------------- (d) a kiosk can register a room, not two guests */

  for i in 1..30 loop
    perform api_register_guest(b, 'G' || i, null, null, 'ar', true, 90, v_client, 60);
  end loop;

  area := 'feature H'; check_name := 'one kiosk can register thirty guests in a window';
  select count(*) into n from guests where event_id = b;
  expected := '30'; actual := n::text; pass := (n = 30); return next;

  area := 'law 11'; check_name := 'and the ceiling still exists above that';
  for i in 1..35 loop
    perform api_register_guest(b, 'H' || i, null, null, 'ar', true, 90, v_client, 60);
  end loop;
  select o.outcome into t from api_register_guest(b, 'last', null, null, 'ar', true, 90, v_client, 60) o;
  expected := 'rate_limited'; actual := t; pass := (t = 'rate_limited'); return next;

  perform gate_cleanup();
  return;
end;
$$;

comment on function gate_moderation_scope() is
  'The four defects the post-freeze audit ranked by event-night cost: no default dollar cap, cross-event moderation, an admin who could not moderate, and a registration limit that throttled a station rather than an attacker.';

create or replace function run_all_gates()
returns table (phase text, area text, check_name text, expected text, actual text, pass boolean)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select 'phase 0'::text, g.area, g.check_name, g.expected, g.actual, g.pass from run_phase_0_gate() g
  union all select 'phase 0'::text, g.area, g.check_name, g.expected, g.actual, g.pass from gate_phase_0_capture() g
  union all select 'phase 1'::text, g.area, g.check_name, g.expected, g.actual, g.pass from gate_phase_1() g
  union all select 'phase 2'::text, g.area, g.check_name, g.expected, g.actual, g.pass from gate_phase_2() g
  union all select 'phase 3'::text, g.area, g.check_name, g.expected, g.actual, g.pass from gate_phase_3() g
  union all select 'phase 4'::text, g.area, g.check_name, g.expected, g.actual, g.pass from gate_phase_4() g
  union all select 'phase 5'::text, g.area, g.check_name, g.expected, g.actual, g.pass from gate_phase_5() g
  union all select 'phase 5'::text, g.area, g.check_name, g.expected, g.actual, g.pass from gate_branding() g
  union all select 'phase 6'::text, g.area, g.check_name, g.expected, g.actual, g.pass from gate_phase_6() g
  union all select 'phase 6'::text, g.area, g.check_name, g.expected, g.actual, g.pass from gate_shirt_catalogue() g
  union all select 'phase 7'::text, g.area, g.check_name, g.expected, g.actual, g.pass from gate_thumbnails() g
  union all select 'phase 7'::text, g.area, g.check_name, g.expected, g.actual, g.pass from gate_reachability() g
  union all select 'phase 7'::text, g.area, g.check_name, g.expected, g.actual, g.pass from gate_credentials() g
  union all select 'audit'::text,   g.area, g.check_name, g.expected, g.actual, g.pass from gate_moderation_scope() g;
$$;

select apply_function_grants();

do $$
declare v_fails integer;
begin
  select count(*) into v_fails from run_all_gates() where not pass;
  if v_fails > 0 then
    raise exception 'gate suite red after 0032: % failing check(s)', v_fails;
  end if;
end
$$;
