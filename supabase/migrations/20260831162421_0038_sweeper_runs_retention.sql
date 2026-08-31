-- 0038 — the sweeper log stops growing forever.
--
-- Law 3 is about telemetry that floods itself: v1 wrote 561k junk error rows in a week. That
-- law was answered for ops_events with dedupe, sampling and a per-device cap — and then the
-- SWEEPER LOG was built beside it with none of that. Three sweepers run every minute, each
-- writing a row whether or not it changed anything, and nothing has ever deleted one. Three
-- days of an idle project produced 9,680 rows; a year produces well over a million. It is the
-- same failure as ledger item 3, in the table that watches for it.
--
-- THE TRAP, and the reason this is not a one-line DELETE. Some of these rows are not
-- heartbeats, they are EVIDENCE: the 90-second AI probe that proves the runtime does not kill
-- law 4's clock, the thumbnail probe for law 7, the anon-reachability probe for law 9, and the
-- hourly storage self-test whose report gate_storage() and gate_sessions() read on every run.
-- A retention sweeper that deleted by age alone would quietly delete the proofs the suite
-- stands on — and the suite would go red, or worse, stay green while asserting against nothing.
--
-- So the rule keeps two things and deletes only what is neither: the newest KEEP rows of every
-- sweeper, always, whatever their age; and everything inside the recent window, however many
-- there are. A row is removed only when it is BOTH outside the window AND not among its
-- sweeper's newest. Probes run at most hourly, so they never leave the newest-200 and are
-- structurally safe. The minute-cadence heartbeats settle at roughly ten thousand rows each
-- and stop climbing.

create or replace function sweep_sweeper_runs()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_keep    constant integer := 200;   -- newest per sweeper, kept regardless of age
  v_days    constant integer := 7;     -- everything inside this window is kept regardless
  v_deleted integer := 0;
begin
  with ranked as (
    select id,
           row_number() over (partition by sweeper order by ran_at desc, id desc) as rn,
           ran_at
      from sweeper_runs
  ),
  doomed as (
    delete from sweeper_runs s
     using ranked r
     where s.id = r.id
       and r.rn > v_keep
       and r.ran_at < now() - make_interval(days => v_days)
       -- Never delete this sweeper's own trail in the same breath as writing to it.
       and s.sweeper <> 'sweep_sweeper_runs'
    returning s.id
  )
  select count(*) into v_deleted from doomed;

  insert into sweeper_runs (sweeper, changed, detail)
  values ('sweep_sweeper_runs', v_deleted,
          jsonb_build_object('deleted', v_deleted, 'keepPerSweeper', v_keep, 'windowDays', v_days));

  return jsonb_build_object('deleted', v_deleted);
end;
$function$;

revoke all on function sweep_sweeper_runs() from public, anon, authenticated;

-- Daily, off the hour, so it never contends with the minute sweepers it prunes.
select cron.schedule('sweep_sweeper_runs', '23 3 * * *', $$select sweep_sweeper_runs();$$);

/* ----------------------------------------------------------------------------- the gate */

create or replace function gate_telemetry_retention()
returns table(area text, check_name text, expected text, actual text, pass boolean)
language plpgsql security definer set search_path = public, pg_temp
as $function$
declare n integer; before_probe integer; after_probe integer;
begin
  delete from sweeper_runs where sweeper like 'gate\_%';

  select count(*) into before_probe from sweeper_runs where sweeper = 'storage_selftest_probe';

  -- Each fixture isolates ONE rule, so neither number can be explained by the other.
  --   gate_noise    — 250 rows, all long expired: only the count rule can save any of them.
  --   gate_recent   — 250 rows, all written now: only the window rule can save the surplus.
  --   gate_evidence — 3 rows, long expired: what a probe looks like, and must not be swept.
  insert into sweeper_runs (sweeper, ran_at, changed, detail)
  select 'gate_noise', now() - interval '30 days', 0, '{}'::jsonb from generate_series(1, 250);
  insert into sweeper_runs (sweeper, ran_at, changed, detail)
  select 'gate_recent', now(), 0, '{}'::jsonb from generate_series(1, 250);
  insert into sweeper_runs (sweeper, ran_at, changed, detail)
  select 'gate_evidence', now() - interval '30 days', 1, '{}'::jsonb from generate_series(1, 3);

  perform sweep_sweeper_runs();

  area := 'law 3'; check_name := 'the sweeper log is bounded: expired surplus heartbeats are deleted';
  select count(*) into n from sweeper_runs where sweeper = 'gate_noise';
  expected := '200 of 250 survive'; actual := n::text || ' survive';
  pass := (n = 200); return next;

  area := 'law 10'; check_name := 'and nothing inside the recent window is ever deleted, however much of it there is';
  select count(*) into n from sweeper_runs where sweeper = 'gate_recent';
  expected := 'all 250'; actual := n::text; pass := (n = 250); return next;

  area := 'law 13'; check_name := 'a sweeper''s newest rows survive any age — evidence is not swept';
  select count(*) into n from sweeper_runs where sweeper = 'gate_evidence';
  expected := '3'; actual := n::text; pass := (n = 3); return next;

  area := 'law 13'; check_name := 'and the real probes the gate suite reads are untouched';
  select count(*) into after_probe from sweeper_runs where sweeper = 'storage_selftest_probe';
  expected := before_probe::text; actual := after_probe::text;
  pass := (after_probe = before_probe); return next;

  area := 'law 10'; check_name := 'the retention sweep is itself visible, like every other sweep';
  select count(*) into n from sweeper_runs
   where sweeper = 'sweep_sweeper_runs' and ran_at > now() - interval '1 minute';
  expected := '>= 1'; actual := n::text; pass := (n >= 1); return next;

  area := 'law 10'; check_name := 'and it is scheduled, not something someone has to remember';
  select count(*) into n from cron.job where jobname = 'sweep_sweeper_runs' and active;
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  delete from sweeper_runs where sweeper like 'gate\_%';
  return;
end;
$function$;

revoke all on function gate_telemetry_retention() from public, anon, authenticated;

create or replace function run_gate_checks()
returns table(phase text, area text, check_name text, expected text, actual text, pass boolean)
language sql security definer set search_path = public, pg_temp
as $function$
  select 'phase 0'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from run_phase_0_gate() g
  union all select 'phase 0'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_phase_0_capture() g
  union all select 'phase 1'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_phase_1() g
  union all select 'phase 2'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_phase_2() g
  union all select 'phase 3'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_phase_3() g
  union all select 'phase 4'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_phase_4() g
  union all select 'phase 5'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_phase_5() g
  union all select 'phase 5'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_branding() g
  union all select 'phase 6'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_phase_6() g
  union all select 'phase 6'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_shirt_catalogue() g
  union all select 'phase 7'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_thumbnails() g
  union all select 'phase 7'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_reachability() g
  union all select 'phase 7'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_credentials() g
  union all select 'audit'::text,   g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_moderation_scope() g
  union all select 'audit'::text,   g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_storage() g
  union all select 'audit'::text,   g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_telemetry_retention() g
  union all select 'outcome'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_sessions() g
  union all select 'outcome'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_ai_refunds() g;
$function$;

do $$
declare bad text; total int;
begin
  select string_agg(g.check_name || ' [' || g.actual || ']', '; ') filter (where not coalesce(g.pass, false)),
         count(*)
    into bad, total from run_all_gates() g;
  if bad is not null then
    raise exception 'GATE_SUITE_RED after 0038 (% checks): %', total, bad;
  end if;
  raise notice 'gate suite green: % checks', total;
end $$;
