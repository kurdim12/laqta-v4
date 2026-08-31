-- 0033_storage_proof.sql
--
-- The storage round trip had never executed. `storage.objects` held zero rows and
-- pg_stat_all_tables reported n_tup_ins = 0 over the project's entire history: the signed
-- upload, the PUT and the signed read that every photo passes through had run zero times in
-- production, and the build machine's network policy refuses CONNECT to this project's own
-- domain, so nothing here could try it.
--
-- The only process that can reach storage is the API function itself, which holds the service
-- key. So it tests itself - uploads a real PNG, signs a read, fetches it back, compares the
-- bytes, proves the signed URL is stable across two signings, and deletes what it made - and
-- writes the result here. This migration is the half that makes that a permanent proof rather
-- than a message someone once read:
--
--   A TOKEN, so the test can be triggered by the platform rather than by a person. The same
--   shape as the AI poke: a secret that lives only in this database, readable only with the
--   service key. No human credential is created, and none is needed.
--
--   A RECORDER, so every run leaves a row - including the runs that fail. A self-test that only
--   records success is a self-test that hides its own bad news.
--
--   A GATE, so the suite asserts what the last run actually proved, forever.
--
--   A SCHEDULE, so the proof stays alive. Three of this suite's checks assert frozen historical
--   probe rows that nothing re-issues - they can never fail again, which makes them decoration.
--   This one is poked hourly by pg_cron and the gate fails if the newest run goes stale, so the
--   check keeps testing something.
--
-- NOTE ON ORDER: this migration deliberately does NOT self-verify. gate_storage() asserts a
-- round trip that has not happened yet at the moment the migration runs, so the suite is red
-- between this statement and the first self-test poke, by design. Every other migration proves
-- its own invariants before finishing; this one cannot, and says so rather than pretending.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

insert into worker_tokens (name, token)
values ('selftest', encode(gen_random_bytes(24), 'hex'))
on conflict (name) do nothing;

/* --------------------------------------------------- the API layer reads its own token */

create or replace function worker_token(p_name text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select token from worker_tokens where name = p_name $$;

comment on function worker_token(text) is
  'Service-role only, like every function here: the anon key can execute nothing (law 9). Returns a poke secret to the process that already holds the service key.';

create or replace function record_selftest(p_detail jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into sweeper_runs (sweeper, changed, detail)
  values ('storage_selftest_probe',
          case when coalesce((p_detail->>'bytesMatch')::boolean, false) then 1 else 0 end,
          p_detail);
$$;

comment on function record_selftest(jsonb) is
  'Every storage self-test leaves a row, pass or fail. gate_storage() asserts the newest one.';

/* ------------------------------------------------------------------------ the gate */

create or replace function gate_storage()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare d jsonb; v_at timestamptz;
begin
  select detail, ran_at into d, v_at from sweeper_runs
   where sweeper = 'storage_selftest_probe'
   order by ran_at desc limit 1;

  area := 'law 1'; check_name := 'a storage round trip has actually been run in production';
  expected := 'a recorded self-test'; actual := coalesce(v_at::text, '(never run)');
  pass := (d is not null); return next;

  if d is null then return; end if;

  area := 'law 1'; check_name := 'the upload was accepted by the real bucket';
  expected := '200'; actual := coalesce(d->>'uploadStatus', '(none)');
  pass := (d->>'uploadStatus' = '200'); return next;

  area := 'law 1'; check_name := 'and the bytes came back identical through a signed read';
  expected := 'true'; actual := coalesce(d->>'bytesMatch', '(none)');
  pass := ((d->>'bytesMatch')::boolean is true); return next;

  area := 'law 7'; check_name := 'signing the same object twice returns the same URL';
  expected := 'true'; actual := coalesce(d->>'urlStable', '(none)');
  pass := ((d->>'urlStable')::boolean is true); return next;

  -- The shape the outbox has to read as success. Supabase answers a duplicate object with
  -- HTTP 400 carrying {"statusCode":"409"}, not with HTTP 409 - reading only the status line
  -- would turn a retry that already succeeded into a permanent failure inside an infinite
  -- retry loop, which is a lost photo wearing the costume of patience.
  area := 'law 1'; check_name := 'a re-uploaded object answers in a shape the outbox tolerates';
  expected := '200, or 4xx naming 409';
  actual := coalesce(d->>'duplicateStatus', '(none)') || ' ' || coalesce(d->>'duplicateBody', '');
  pass := (d->>'duplicateStatus' = '200'
           or coalesce(d->>'duplicateBody', '') ~ '"statusCode"\s*:\s*"?409"?'
           or d->>'duplicateStatus' = '409'); return next;

  area := 'law 10'; check_name := 'the self-test cleans up the object it made';
  expected := 'true'; actual := coalesce(d->>'deleted', '(none)');
  pass := ((d->>'deleted')::boolean is true); return next;

  -- A probe nothing re-runs is a check that can never fail again. This one is poked hourly;
  -- a week of silence means the schedule died and the proof above is a museum piece.
  area := 'law 13'; check_name := 'the storage proof is still being re-run, not frozen';
  expected := 'newer than 7 days';
  actual := age(now(), v_at)::text;
  pass := (v_at > now() - interval '7 days'); return next;

  return;
end;
$$;

comment on function gate_storage() is
  'Asserts the recorded production storage round trip: upload accepted, bytes identical, signed URL stable, duplicate shape tolerable, object cleaned up.';

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
  union all select 'audit'::text,   g.area, g.check_name, g.expected, g.actual, g.pass from gate_moderation_scope() g
  union all select 'audit'::text,   g.area, g.check_name, g.expected, g.actual, g.pass from gate_storage() g;
$$;

-- The literal URL matches 0021's poke: this project has no settings table, and inventing one
-- for a single constant would be a second place for the same fact to be wrong.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable -- skipping storage self-test schedule';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'poke_selftest') then
    perform cron.unschedule('poke_selftest');
  end if;
  perform cron.schedule('poke_selftest', '17 * * * *', $cron$
    select net.http_post(
      url := 'https://bdzdvlnmocojsifdkpvd.supabase.co/functions/v1/api',
      body := jsonb_build_object('action', 'ops.selfTest'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-laqta-worker', (select token from worker_tokens where name = 'selftest')
      ),
      timeout_milliseconds := 20000
    );
  $cron$);
end
$$;

select apply_function_grants();
