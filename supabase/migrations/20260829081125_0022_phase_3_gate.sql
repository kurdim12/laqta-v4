-- 0022_phase_3_gate.sql
--
-- The Phase 3 gate. Everything deterministic about the AI runner is checked here against the
-- live schema; the one thing that could only be proven by running on the real infrastructure
-- - that a 90-second-class generation is not killed by the platform - was run live and left a
-- permanent record, which this gate asserts on: sweeper_runs holds an ai_worker_probe row
-- whose measured elapsed time crossed 90 seconds on the production runtime.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

create or replace function gate_phase_3()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  a uuid; opA uuid; ph uuid; jb uuid; jb2 uuid;
  n integer; t text; ok boolean; money numeric;
begin
  perform gate_cleanup();

  /* ------------------------------------------------- the runner's infrastructure (law 4) */

  area := 'law 4'; check_name := 'the recorded 90-second-class run survived the platform';
  select (detail->>'elapsedMs')::integer into n
    from sweeper_runs where sweeper = 'ai_worker_probe'
   order by ran_at desc limit 1;
  expected := '>= 90000 ms measured live'; actual := coalesce(n::text, '(no probe record)');
  pass := (n is not null and n >= 90000); return next;

  area := 'law 4'; check_name := 'the minute poke is scheduled';
  select count(*) into n from cron.job where jobname = 'poke_ai_worker' and active;
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  area := 'law 4'; check_name := 'the poke is authenticated by a database-held token';
  select length(token) into n from worker_tokens where name = 'ai-worker';
  expected := '48 hex chars'; actual := coalesce(n::text, '(missing)'); pass := (n = 48); return next;

  /* -------------------------------------------------------------------- the queue (laws 1, 4) */

  insert into events (slug, name, status, ai_budget_usd, ai_est_cost_usd, max_generations)
  values ('gate-ai', 'Gate AI', 'live', 0.10, 0.04, 1000) returning id into a;
  select id into opA from api_create_operator(a, 'gateai3', 'Gate AI', 'A', 'operator', '6161');
  ph := gen_random_uuid();
  insert into photos (id, event_id, operator_id, kind, storage_path, thumb_path, bytes, status)
  values (ph, a, opA, 'original', 'o/src.jpg', 't/src.jpg', 10, 'ready');

  select id into jb from api_enqueue_job(a, ph, opA);
  select id into jb2 from api_enqueue_job(a, ph, opA);

  area := 'law 1'; check_name := 'a replayed enqueue converges on the existing job';
  expected := 'same job id'; actual := case when jb = jb2 then 'same job id' else 'A SECOND JOB' end;
  pass := (jb = jb2); return next;

  area := 'law 1'; check_name := 'and there is exactly one active job for the photo';
  select count(*) into n from ai_jobs where photo_id = ph and status <> 'failed';
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  -- the full lifecycle, as the worker drives it
  perform claim_ai_job(a, 'gate-worker');

  area := 'law 4'; check_name := 'a claimed job holds a lease and a start time';
  select (lease_until is not null and started_at is not null and locked_by = 'gate-worker')
    into ok from ai_jobs where id = jb;
  expected := 'true'; actual := coalesce(ok::text, '(gone)'); pass := (ok is true); return next;

  perform api_job_succeeded(jb, null, 'gate-model', 91000, 0.021);

  area := 'feature D'; check_name := 'the cost log records model and latency';
  select (model = 'gate-model' and latency_ms = 91000 and cost_usd = 0.021)
    into ok from ai_jobs where id = jb;
  expected := 'true'; actual := coalesce(ok::text, '(gone)'); pass := (ok is true); return next;

  area := 'law 1'; check_name := 'a photo whose job failed may be enqueued again, once terminal';
  update ai_jobs set status = 'failed', error = 'gate' where id = jb;
  select id into jb2 from api_enqueue_job(a, ph, opA);
  expected := 'a new job'; actual := case when jb2 is distinct from jb then 'a new job' else 'the failed one' end;
  pass := (jb2 is distinct from jb); return next;

  /* --------------------------------------------------------- pause reaches the drain (law 5) */

  -- jb2 is a live queued job. Pausing the event must hide it from the drain without touching
  -- the job itself; unpausing must reveal it again.
  update events set ai_paused = true where id = a;

  area := 'law 5'; check_name := 'a paused event is invisible to the worker''s drain';
  select count(*) into n from api_events_with_queued_jobs() w where w.event_id = a;
  expected := '0'; actual := n::text; pass := (n = 0); return next;

  update events set ai_paused = false where id = a;

  area := 'law 5'; check_name := 'and visible again the moment the pause lifts';
  select count(*) into n from api_events_with_queued_jobs() w where w.event_id = a;
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  update ai_jobs set status = 'failed', error = 'gate' where id = jb2;

  /* ------------------------------------------------- money: cap before spend, settle after (D) */

  ok := consume_generation(a, 0.04);
  area := 'feature D'; check_name := 'the first reservation inside the budget is allowed';
  expected := 'true'; actual := ok::text; pass := ok; return next;

  ok := consume_generation(a, 0.04);
  area := 'feature D'; check_name := 'so is the second';
  expected := 'true'; actual := ok::text; pass := ok; return next;

  ok := consume_generation(a, 0.04);
  area := 'feature D'; check_name := 'the reservation that would cross the cap is refused BEFORE spend';
  expected := 'false'; actual := ok::text; pass := (not ok); return next;

  perform settle_generation(a, 0.04, 0.021);
  perform settle_generation(a, 0.04, 0);

  area := 'feature D'; check_name := 'settlement swaps estimates for reality, refunding failures';
  select ai_spend_usd into money from events where id = a;
  expected := '0.021'; actual := money::text; pass := (money = 0.021); return next;

  /* ------------------------------------------------------------- cutouts and law 7 (2, 7) */

  perform api_set_photo_cutout(ph, 'gate/cut.png');
  update photos set approved = true, approved_by = opA, approved_at = now() where id = ph;

  area := 'law 2'; check_name := 'a cutout, when one exists, reaches the wall';
  select w.cutout_path into t from wall_photos('gate-ai', 10) w where w.id = ph;
  expected := 'gate/cut.png'; actual := coalesce(t, '(null)'); pass := (t = 'gate/cut.png'); return next;

  area := 'law 7'; check_name := 'the wall type still cannot name an original';
  select pg_get_function_result(p.oid) into t
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'wall_photos';
  expected := 'no storage_path'; actual := left(coalesce(t, '(missing)'), 60);
  pass := (t is not null and t !~ 'storage_path'); return next;

  /* ------------------------------------------------------------------ the model picker (D) */

  begin
    perform api_set_event_ai('gate-ai', null, 'not/a-real-model');
    ok := false;
  exception when others then
    ok := (sqlerrm = 'MODEL_NOT_ALLOWED');
  end;
  area := 'feature D'; check_name := 'a model outside the allowed list is refused';
  expected := 'refused'; actual := case when ok then 'refused' else 'ACCEPTED' end;
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
    from gate_phase_3() g;
$$;

select apply_function_grants();

do $$
declare v_fails integer;
begin
  select count(*) into v_fails from run_all_gates() where not pass;
  if v_fails > 0 then
    raise exception 'gate suite red after 0022: % failing check(s)', v_fails;
  end if;
end
$$;
