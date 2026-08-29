-- 0023_control_room.sql
--
-- Phase 4, the data layer: what the control room, war room and moderation surfaces read.
--
--   THE MODERATION FEED IS A NAMED SHAPE. Queue and war room need thumbnails, the capture
--   surface (booth vs kiosk), the operator's per-shot intent and the latest job state - and
--   nothing else. api_booth_feed from 0003 predates half those columns and returns the raw
--   photos row; this feed is the explicit column list the moderation surfaces are allowed to
--   see, so widening photos later cannot silently widen moderation.
--
--   TEN SECONDS MEANS TEN SECONDS. The phase gate says a killed station shows offline within
--   ten seconds. The per-event threshold's default drops from 30 to 8: with stations
--   heartbeating every 3 seconds and ops polling every 2, a dead station is visibly dead
--   inside the gate's window with margin. Existing events are brought to the new default;
--   the column stays per-event (law 5) for venues that want it looser.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

create or replace function api_moderation_feed(p_event_id uuid, p_limit integer default 60)
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
  'What moderation surfaces may see, as an explicit column list. Thumbnails and cutouts, never storage_path; the deleted stay deleted.';

alter table events alter column station_offline_seconds set default 8;
update events set station_offline_seconds = 8 where station_offline_seconds = 30;

/* --------------------------------------------------------------------- the Phase 4 gate */

create or replace function gate_phase_4()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  a uuid; b uuid; opA uuid; ph uuid;
  n integer; t text; ok boolean; js jsonb;
begin
  perform gate_cleanup();

  insert into events (slug, name, status) values ('gate-ops', 'Gate Ops', 'live') returning id into a;
  insert into events (slug, name, status) values ('gate-ops-b', 'Gate Ops B', 'live') returning id into b;
  select id into opA from api_create_operator(a, 'gateops', 'Gate Ops', 'A', 'operator', '7272');

  /* ------------------------------------------ the kill-a-station clock (feature G, law 10) */

  area := 'feature G'; check_name := 'a new event''s offline threshold is inside the 10-second gate';
  select station_offline_seconds into n from events where id = a;
  expected := '8'; actual := n::text; pass := (n = 8); return next;

  perform api_station_heartbeat(a, 'gate-tablet', 'booth', 'Booth A', 3, 'phase-4');

  area := 'feature G'; check_name := 'a beating station reads online';
  select online into ok from api_stations(a) where device_id = 'gate-tablet';
  expected := 'true'; actual := coalesce(ok::text, '(none)'); pass := (ok is true); return next;

  -- the kill: nine seconds of silence is already past the threshold
  update stations set last_heartbeat_at = now() - interval '9 seconds'
   where event_id = a and device_id = 'gate-tablet';

  area := 'feature G'; check_name := 'nine seconds after its last beat, the station reads offline';
  select online into ok from api_stations(a) where device_id = 'gate-tablet';
  expected := 'false'; actual := coalesce(ok::text, '(none)'); pass := (ok is false); return next;

  area := 'feature G'; check_name := 'and its queue depth is still shown while it is dead';
  select queue_depth into n from api_stations(a) where device_id = 'gate-tablet';
  expected := '3'; actual := coalesce(n::text, '(none)'); pass := (n = 3); return next;

  /* ----------------------------------------------- law 5 re-proven through the switches */

  perform api_set_event_switches(a, true, true, true, true, true, 'x', 'y', opA, null);

  area := 'law 5'; check_name := 're-proof: every switch on one event, the other untouched';
  select (wall_frozen or panic_brand_only or intake_paused or ai_paused or banner_active)
    into ok from events where id = b;
  expected := 'untouched'; actual := case when ok then 'LEAKED' else 'untouched' end;
  pass := (not ok); return next;

  area := 'law E'; check_name := 'the switch change is in the audit trail with its actor';
  select count(*) into n from audit_log
   where event_id = a and action = 'set_switches' and actor_label like 'gateops%';
  expected := '>= 1'; actual := n::text; pass := (n >= 1); return next;

  perform api_set_event_switches(a, false, false, false, false, false, null, null, opA, null);

  /* --------------------------------------------------- the moderation feed's shape (E, 7) */

  ph := gen_random_uuid();
  perform api_upsert_photo_if_absent(ph, a, opA, 'original', 'o/m.jpg', 't/m.jpg', 10,
                                     'gate-tablet', now(), 'kiosk', 'straight');
  perform api_confirm_photo(ph);

  area := 'feature G'; check_name := 'the feed carries the capture surface for the war-room columns';
  select mf.capture_source into t from api_moderation_feed(a, 10) mf where mf.id = ph;
  expected := 'kiosk'; actual := coalesce(t, '(null)'); pass := (t = 'kiosk'); return next;

  area := 'law 7'; check_name := 'the moderation shape has no storage_path and no credentials';
  select pg_get_function_result(p.oid) into t
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'api_moderation_feed';
  expected := 'absent from the type'; actual := left(coalesce(t, '(missing)'), 60);
  pass := (t is not null and t !~* '(storage_path|pin_hash|password)'); return next;

  perform api_delete_photo(ph, opA, 'gate');

  area := 'law E'; check_name := 'a deleted photo leaves the moderation feed';
  select count(*) into n from api_moderation_feed(a, 10) mf where mf.id = ph;
  expected := '0'; actual := n::text; pass := (n = 0); return next;

  /* ------------------------------------------------ the overview's numbers exist (G, 3, 10) */

  select api_ops_summary('gate-ops') into js;

  area := 'feature G'; check_name := 'the ops summary carries the spend meter and sane telemetry';
  ok := (js ? 'remainingBudget') and (js ? 'telemetry') and (js ? 'sweepers')
        and ((js->'event') ? 'ai_spend_usd');
  expected := 'spend, telemetry, sweepers present'; actual := case when ok then 'present' else 'MISSING' end;
  pass := ok; return next;

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
    from gate_phase_4() g;
$$;

select apply_function_grants();

do $$
declare v_fails integer;
begin
  select count(*) into v_fails from run_all_gates() where not pass;
  if v_fails > 0 then
    raise exception 'gate suite red after 0023: % failing check(s)', v_fails;
  end if;
end
$$;