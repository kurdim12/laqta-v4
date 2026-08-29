-- 0027_revived_five.sql
--
-- Phase 6, the data layer: the revived five arrive as first-class, event-scoped shapes.
--
--   EVERYTHING JOINS THE ONE QUEUE. The shirt picker and the avatar kiosk do not get their
--   own pipelines: their shots are ordinary photos rows with a capture_source the vocabulary
--   has reserved for them since 0014, and the moderation feed carries the guest's shirt
--   choice so a moderator can see what was asked for. A per-shot style choice is provenance:
--   written at capture, immune to retries, readable by the AI runner.
--
--   CUES AND TASKS ARE ROWS, NOT NOTES. Show cues and crew tasks live in tables scoped by
--   event_id (law 5), their status changes land in the capped telemetry stream (law 3), and
--   the control room reads and writes them through the same single API layer as everything
--   else (law 9).
--
-- Append-only. Never edit a migration that has been applied; add a new one.

/* --------------------------------------------- the per-shot style choice (feature I, C) */

alter table photos add column style_choice text;

comment on column photos.style_choice is
  'What the guest picked at a picker surface (a shirt, a look). Capture provenance: set at the shutter, never rewritten by a retry, read by the AI runner when it styles the shot.';

/* Shirt options are event config like every other setting (law 5). */
alter table events add column shirt_options jsonb not null default '[]'::jsonb;

comment on column events.shirt_options is
  'The shirt picker''s catalogue for this event: [{id, en, ar}]. Empty means the surface honestly offers nothing.';

drop function if exists api_upsert_photo_if_absent(uuid, uuid, uuid, text, text, text, integer, text, timestamptz, text, text, uuid);

create function api_upsert_photo_if_absent(
  p_photo_id           uuid,
  p_event_id           uuid,
  p_operator_id        uuid,
  p_kind               text,
  p_storage_path       text,
  p_thumb_path         text,
  p_bytes              integer,
  p_device_id          text default null,
  p_client_captured_at timestamptz default null,
  p_capture_source     text default 'booth',
  p_restyle_intent     text default 'straight',
  p_guest_id           uuid default null,
  p_style_choice       text default null
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
  -- second photo. 'do nothing' rather than 'do update' on purpose - a retry must not be able
  -- to rewrite the provenance of a shot that already landed: not its capture surface, not its
  -- guest, and not the shirt the guest actually chose.
  return query
    insert into photos (id, event_id, operator_id, kind, storage_path, thumb_path, bytes,
                        status, device_id, client_captured_at, capture_source, restyle_intent,
                        guest_id, style_choice)
    values (p_photo_id, p_event_id, p_operator_id, p_kind, p_storage_path, p_thumb_path,
            p_bytes, 'processing', p_device_id,
            coalesce(p_client_captured_at, now()),
            coalesce(p_capture_source, 'booth'),
            coalesce(p_restyle_intent, 'straight'),
            p_guest_id, p_style_choice)
    on conflict (id) do nothing
    returning *;

  if not found then
    return query select * from photos where id = p_photo_id;
  end if;
end;
$$;

comment on function api_upsert_photo_if_absent(uuid, uuid, uuid, text, text, text, integer, text, timestamptz, text, text, uuid, text) is
  'The capture write. Idempotent on the client-minted id; records surface, intent, guest and style choice at the shutter, none of which a retry can rewrite.';

/* ------------------------------ the moderation feed carries the choice (features E and I) */

drop function if exists api_moderation_feed(uuid, integer);

create function api_moderation_feed(p_event_id uuid, p_limit integer default 60)
returns table (
  id uuid,
  kind text,
  status text,
  approved boolean,
  created_at timestamptz,
  thumb_path text,
  cutout_path text,
  capture_source text,
  restyle_intent text,
  style_choice text,
  source_photo_id uuid,
  operator_booth text,
  job_status text,
  job_error text,
  result_photo_id uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.kind, p.status, p.approved, p.created_at,
         p.thumb_path, p.cutout_path, p.capture_source, p.restyle_intent,
         p.style_choice,
         p.source_photo_id,
         o.booth,
         j.status, j.error, j.result_photo_id
    from photos p
    left join operators o on o.id = p.operator_id
    left join lateral (
      select j.status, j.error, j.result_photo_id
        from ai_jobs j
       where j.photo_id = p.id or j.result_photo_id = p.id
       order by j.created_at desc
       limit 1
    ) j on true
   where p.event_id = p_event_id
     and p.status <> 'deleted'
   order by p.created_at desc
   limit greatest(1, least(coalesce(p_limit, 60), 200));
$$;

comment on function api_moderation_feed(uuid, integer) is
  'What moderation surfaces may see, as an explicit column list. Thumbnails, cutouts and the guest''s choice; never storage_path; the deleted stay deleted.';

/* ------------------------------------ the public shape offers the catalogue (features I, C) */

drop function if exists api_event_public(text);

create function api_event_public(p_event_slug text)
returns table (
  slug text, name text, name_ar text, name_en text, status text,
  locale_default text, locales text[],
  brand_primary text, brand_secondary text, brand_font_family text,
  brand_logo_path text,
  wall_frozen boolean, panic_brand_only boolean,
  banner_active boolean, banner_text_en text, banner_text_ar text,
  guest_mode text, wall_config jsonb, shirt_options jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.slug, e.name, e.name_ar, e.name_en, e.status,
         e.locale_default, e.locales,
         e.brand_primary, e.brand_secondary, e.brand_font_family,
         e.brand_logo_path,
         e.wall_frozen, e.panic_brand_only,
         e.banner_active, e.banner_text_en, e.banner_text_ar,
         e.guest_mode, e.wall_config, e.shirt_options
    from events e
   where e.slug = p_event_slug;
$$;

comment on function api_event_public(text) is
  'The whole of what a wall or guest surface may know about an event. AI prompt, budgets and spend are structurally absent: not in the return type.';

/* ------------------------------------------------- show cues and crew tasks (feature I, G) */

create table show_cues (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references events (id),
  position   integer not null default 0,
  title_en   text not null default '',
  title_ar   text not null default '',
  status     text not null default 'pending' check (status in ('pending', 'standby', 'done')),
  fired_at   timestamptz,
  created_at timestamptz not null default now()
);
alter table show_cues enable row level security;
create index show_cues_event_idx on show_cues (event_id, position, created_at);

create table crew_tasks (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references events (id),
  title      text not null,
  assignee   text,
  status     text not null default 'open' check (status in ('open', 'done')),
  done_at    timestamptz,
  created_at timestamptz not null default now()
);
alter table crew_tasks enable row level security;
create index crew_tasks_event_idx on crew_tasks (event_id, status, created_at);

create or replace function api_list_cues(p_event_id uuid)
returns setof show_cues language sql stable security definer set search_path = public, pg_temp
as $$ select * from show_cues where event_id = p_event_id order by position, created_at $$;

create or replace function api_save_cue(
  p_id uuid, p_event_id uuid, p_position integer, p_title_en text, p_title_ar text
)
returns setof show_cues
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_id is null then
    return query
      insert into show_cues (event_id, position, title_en, title_ar)
      values (p_event_id, coalesce(p_position, 0), coalesce(p_title_en, ''), coalesce(p_title_ar, ''))
      returning *;
  else
    return query
      update show_cues
         set position = coalesce(p_position, position),
             title_en = coalesce(p_title_en, title_en),
             title_ar = coalesce(p_title_ar, title_ar)
       where id = p_id and event_id = p_event_id
      returning *;
  end if;
end;
$$;

create or replace function api_set_cue_status(
  p_id uuid, p_event_id uuid, p_status text, p_actor text default null
)
returns setof show_cues
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
    update show_cues
       set status = p_status,
           fired_at = case when p_status = 'done' then now() else fired_at end
     where id = p_id and event_id = p_event_id
    returning *;
  -- The show's heartbeat is telemetry, not audit: capped, deduped, never blocking (law 3).
  perform record_op('control', 'cue_' || p_status, true, null, p_event_id,
                    jsonb_build_object('cueId', p_id), coalesce(p_actor, 'control'));
end;
$$;

create or replace function api_delete_cue(p_id uuid, p_event_id uuid)
returns void language sql security definer set search_path = public, pg_temp
as $$ delete from show_cues where id = p_id and event_id = p_event_id $$;

create or replace function api_list_tasks(p_event_id uuid)
returns setof crew_tasks language sql stable security definer set search_path = public, pg_temp
as $$ select * from crew_tasks where event_id = p_event_id order by status desc, created_at $$;

create or replace function api_save_task(
  p_id uuid, p_event_id uuid, p_title text, p_assignee text default null
)
returns setof crew_tasks
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_id is null then
    return query
      insert into crew_tasks (event_id, title, assignee)
      values (p_event_id, p_title, p_assignee)
      returning *;
  else
    return query
      update crew_tasks
         set title = coalesce(p_title, title), assignee = coalesce(p_assignee, assignee)
       where id = p_id and event_id = p_event_id
      returning *;
  end if;
end;
$$;

create or replace function api_set_task_status(
  p_id uuid, p_event_id uuid, p_status text, p_actor text default null
)
returns setof crew_tasks
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
    update crew_tasks
       set status = p_status,
           done_at = case when p_status = 'done' then now() else null end
     where id = p_id and event_id = p_event_id
    returning *;
  perform record_op('control', 'task_' || p_status, true, null, p_event_id,
                    jsonb_build_object('taskId', p_id), coalesce(p_actor, 'control'));
end;
$$;

create or replace function api_delete_task(p_id uuid, p_event_id uuid)
returns void language sql security definer set search_path = public, pg_temp
as $$ delete from crew_tasks where id = p_id and event_id = p_event_id $$;

/* -------------------------------------------------- cleanup knows the new tables (law 13) */

create or replace function gate_cleanup()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_ids from events where slug like 'gate-%';
  delete from wall_cells             where event_id = any(v_ids);
  delete from guest_codes            where event_id = any(v_ids);
  delete from ai_jobs                where event_id = any(v_ids);
  delete from photos                 where event_id = any(v_ids);
  delete from guests                 where event_id = any(v_ids);
  delete from show_cues              where event_id = any(v_ids);
  delete from crew_tasks             where event_id = any(v_ids);
  delete from audit_log              where event_id = any(v_ids);
  delete from ops_events             where event_id = any(v_ids);
  delete from ops_quota              where event_id = any(v_ids);
  delete from rate_limits            where event_id = any(v_ids);
  delete from operator_login_attempts where event_id = any(v_ids);
  delete from stations               where event_id = any(v_ids);
  delete from operators              where event_id = any(v_ids);
  delete from events                 where id = any(v_ids);
  delete from platform_rate_limits   where subject like 'gate-%';
  delete from admins                 where username like 'gateadmin%';
  delete from sweeper_runs           where sweeper like 'gate_%';
end;
$$;

/* --------------------------------------------------------------------- the Phase 6 gate */

create or replace function gate_phase_6()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  a uuid; b uuid; opA uuid; ph uuid; cue uuid; task uuid;
  n integer; t text; ok boolean;
begin
  perform gate_cleanup();

  insert into events (slug, name, status, shirt_options)
  values ('gate-i-a', 'Gate Revived A', 'live',
          '[{"id":"white-classic","en":"Classic White","ar":"أبيض كلاسيكي"}]'::jsonb)
  returning id into a;
  insert into events (slug, name, status) values ('gate-i-b', 'Gate Revived B', 'live') returning id into b;
  select id into opA from api_create_operator(a, 'gateio', 'Gate I Op', 'A', 'operator', '9753');

  /* ------------------------------------- the shirt picker joins the one queue (I, E, C) */

  ph := gen_random_uuid();
  perform api_upsert_photo_if_absent(ph, a, opA, 'original', 'o/i1.jpg', 't/i1.jpg', 10,
                                     'gate-i-dev', now(), 'shirt', 'restyle', null, 'white-classic');
  perform api_confirm_photo(ph);

  area := 'feature I'; check_name := 'a shirt-picker shot is an ordinary unapproved photo in the queue';
  select count(*) into n from api_moderation_feed(a, 10) mf
   where mf.id = ph and mf.capture_source = 'shirt' and mf.approved = false;
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  area := 'feature I'; check_name := 'the moderation feed shows what the guest chose';
  select mf.style_choice into t from api_moderation_feed(a, 10) mf where mf.id = ph;
  expected := 'white-classic'; actual := coalesce(t, '(null)'); pass := (t = 'white-classic'); return next;

  area := 'law 1'; check_name := 'a replayed capture cannot rewrite the choice';
  perform api_upsert_photo_if_absent(ph, a, opA, 'original', 'o/i1.jpg', 't/i1.jpg', 10,
                                     'gate-i-dev', now(), 'shirt', 'restyle', null, 'SOMETHING-ELSE');
  select p.style_choice into t from photos p where p.id = ph;
  expected := 'white-classic'; actual := t; pass := (t = 'white-classic'); return next;

  area := 'feature I'; check_name := 'an avatar-surface shot lands in the same queue';
  ph := gen_random_uuid();
  perform api_upsert_photo_if_absent(ph, a, opA, 'original', 'o/i2.jpg', 't/i2.jpg', 10,
                                     'gate-i-dev', now(), 'avatar', 'straight', null, null);
  perform api_confirm_photo(ph);
  select count(*) into n from api_moderation_feed(a, 10) mf
   where mf.id = ph and mf.capture_source = 'avatar' and mf.approved = false;
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  area := 'feature C'; check_name := 'the public shape offers the shirt catalogue';
  select pg_get_function_result(p.oid) into t
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'api_event_public';
  expected := 'shirt_options present, AI config absent';
  actual := case when t ~* 'shirt_options' and t !~* '(ai_prompt|budget|spend)'
                 then 'as expected' else 'WRONG SHAPE' end;
  pass := (t ~* 'shirt_options' and t !~* '(ai_prompt|budget|spend)'); return next;

  /* ------------------------------------------------ cues and tasks, event-scoped (I, G, 5) */

  select id into cue from api_save_cue(null, a, 1, 'Doors open', 'فتح الأبواب');
  select id into task from api_save_task(null, a, 'Check LED wall power', 'Rami');

  area := 'law 5'; check_name := 'cues and tasks belong to their event alone';
  select (select count(*) from api_list_cues(b)) + (select count(*) from api_list_tasks(b)) into n;
  expected := '0 on the other event'; actual := n::text; pass := (n = 0); return next;

  area := 'feature I'; check_name := 'firing a cue records the moment';
  perform api_set_cue_status(cue, a, 'done', 'gateio');
  select (status = 'done' and fired_at is not null) into ok from show_cues where id = cue;
  expected := 'done with fired_at'; actual := coalesce(ok::text, '(none)'); pass := (ok is true); return next;

  area := 'feature I'; check_name := 'closing a task records the moment';
  perform api_set_task_status(task, a, 'done', 'gateio');
  select (status = 'done' and done_at is not null) into ok from crew_tasks where id = task;
  expected := 'done with done_at'; actual := coalesce(ok::text, '(none)'); pass := (ok is true); return next;

  area := 'law 3'; check_name := 'cue and task activity flows through the capped telemetry';
  select count(*) into n from ops_events
   where event_id = a and event in ('cue_done', 'task_done');
  expected := '>= 2'; actual := n::text; pass := (n >= 2); return next;

  area := 'law 5'; check_name := 'a cue cannot be moved to another event''s scope';
  perform api_set_cue_status(cue, b, 'pending', 'gateio');
  select status into t from show_cues where id = cue;
  expected := 'done (the cross-event write matched nothing)'; actual := t; pass := (t = 'done'); return next;

  perform gate_cleanup();
  return;
end;
$$;

create or replace function run_all_gates()
returns table (phase text, area text, check_name text, expected text, actual text, pass boolean)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select 'phase 0'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from run_phase_0_gate() g
  union all
  select 'phase 0'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_0_capture() g
  union all
  select 'phase 1'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_1() g
  union all
  select 'phase 2'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_2() g
  union all
  select 'phase 3'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_3() g
  union all
  select 'phase 4'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_4() g
  union all
  select 'phase 5'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_5() g
  union all
  select 'phase 5'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_branding() g
  union all
  select 'phase 6'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_6() g;
$$;

select apply_function_grants();

do $$
declare v_fails integer;
begin
  select count(*) into v_fails from run_all_gates() where not pass;
  if v_fails > 0 then
    raise exception 'gate suite red after 0027: % failing check(s)', v_fails;
  end if;
end
$$;