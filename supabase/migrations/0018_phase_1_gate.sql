-- 0018_phase_1_gate.sql
--
-- The server half of the Phase 1 gate. The device half - photos surviving an outage, a
-- restart and a retry, arriving exactly once - is a browser test, because it can only be
-- proved by actually cutting a browser's network: tests/gate/phase-1/airplane.spec.ts.
--
-- What belongs here is what the database is responsible for under law 1: that a retried write
-- cannot become a second photo no matter how many times it arrives, and that a station's queue
-- depth and liveness are visible to ops so a booth falling behind is seen rather than guessed.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

create or replace function gate_phase_1()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  a uuid; opA uuid; ph uuid; i integer; n integer; t text; b boolean;
begin
  perform gate_cleanup();

  insert into events (slug, name, status, station_offline_seconds)
  values ('gate-offline', 'Gate Offline', 'live', 30) returning id into a;
  select id into opA from api_create_operator(a, 'gateoff', 'Gate Off', 'A', 'operator', '3141');

  /* ------------------------------------------------------------ law 1, the server's half */

  -- An outbox that reconnects after an outage may replay the same write many times: the
  -- request that timed out may in fact have landed. Twenty replays, one photo.
  ph := gen_random_uuid();
  for i in 1..20 loop
    perform api_upsert_photo_if_absent(
      ph, a, opA, 'original', 'o/replay.jpg', 't/replay.jpg', 500,
      'tablet-1', now() - interval '15 minutes', 'booth', 'straight');
  end loop;

  area := 'law 1'; check_name := 'twenty replays of one shot make one photo';
  select count(*) into n from photos where id = ph;
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  -- Confirm is replayed too, by a device that never saw the first response.
  for i in 1..5 loop
    perform api_confirm_photo(ph);
  end loop;

  area := 'law 1'; check_name := 'replayed confirmations are harmless';
  select status into t from photos where id = ph;
  expected := 'ready'; actual := t; pass := (t = 'ready'); return next;

  area := 'law 1'; check_name := 'ten distinct shots stay ten distinct photos';
  for i in 1..10 loop
    perform api_upsert_photo_if_absent(
      gen_random_uuid(), a, opA, 'original', 'o/x' || i || '.jpg', 't/x' || i || '.jpg', 10,
      'tablet-1', now(), 'booth', 'straight');
  end loop;
  select count(*) into n from photos where event_id = a;
  expected := '11 (ten plus the replayed one)'; actual := n::text; pass := (n = 11); return next;

  /* ------------------------------------------- stations, queue depth and liveness (G, 10) */

  perform api_station_heartbeat(a, 'tablet-1', 'booth', 'Booth A', 7, 'phase-1');

  area := 'phase 1'; check_name := 'a station reports how much it is still holding';
  select queue_depth into n from api_stations(a) where device_id = 'tablet-1';
  expected := '7'; actual := coalesce(n::text, '(none)'); pass := (n = 7); return next;

  area := 'phase 1'; check_name := 'a station that just beat is online';
  select online into b from api_stations(a) where device_id = 'tablet-1';
  expected := 'true'; actual := coalesce(b::text, '(none)'); pass := (b is true); return next;

  -- Ops must notice a dead station quickly. The threshold is per-event, like everything else.
  update stations set last_heartbeat_at = now() - interval '31 seconds'
   where event_id = a and device_id = 'tablet-1';

  area := 'phase 1'; check_name := 'a station that stopped beating shows offline within its threshold';
  select online into b from api_stations(a) where device_id = 'tablet-1';
  expected := 'false'; actual := coalesce(b::text, '(none)'); pass := (b is false); return next;

  area := 'phase 1'; check_name := 'and its queue depth is still readable while it is offline';
  select queue_depth into n from api_stations(a) where device_id = 'tablet-1';
  expected := '7'; actual := coalesce(n::text, '(none)'); pass := (n = 7); return next;

  -- A device coming back reports its remaining depth rather than creating a second station.
  perform api_station_heartbeat(a, 'tablet-1', 'booth', 'Booth A', 0, 'phase-1');

  area := 'phase 1'; check_name := 'a returning station updates in place, it does not multiply';
  select count(*) into n from api_stations(a) where device_id = 'tablet-1';
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  area := 'phase 1'; check_name := 'and a drained device reports an empty queue';
  select queue_depth into n from api_stations(a) where device_id = 'tablet-1';
  expected := '0'; actual := coalesce(n::text, '(none)'); pass := (n = 0); return next;

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
    from gate_phase_1() g;
$$;

select apply_function_grants();

do $$
declare v_count integer;
begin
  select count(*) into v_count from assert_schema_locked();
  if v_count > 0 then
    raise exception 'schema lock assertion failed with % violation(s) after 0018', v_count;
  end if;
end
$$;
