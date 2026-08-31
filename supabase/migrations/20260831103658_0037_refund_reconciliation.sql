-- 0037 — refund reconciliation.
--
-- Outcome gate 4: "forced post-payment failure reconciles to the cent; spend == successful
-- generations, under the cap."
--
-- Two things were wrong, and both of them read as prudence.
--
-- 1. THE REFUND WAS A LIE ON ONE SIDE. The worker's catch refunded the reservation to zero for
--    every failure. But the paid call sits in the middle of that try block: if the model
--    returned bytes — and charged us for them — and the storage upload or the insert then
--    failed, the money is real and the meter forgot it. An event could spend its way past a
--    budget the cap was still cheerfully enforcing against a number nobody was paying.
--
-- 2. A REFUNDED GENERATION STAYED SPENT. consume_generation increments generations_used;
--    settle_generation only ever touched dollars. So a transient failure gave the money back
--    and kept the generation. Three retries of one photo burned three of an event's N
--    generations and produced nothing.
--
-- The fix is not "remember to pass the right number". It is to put the reservation ON THE JOB,
-- so the books can be checked rather than trusted:
--
--     events.ai_spend_usd     == sum(ai_jobs.spent_usd) + sum(ai_jobs.reserved_usd)
--     events.generations_used == sum(ai_jobs.generations_charged) + count(reserved)
--
-- The meter equals what we have paid plus what we have promised — an invariant that holds at
-- every instant, including mid-flight with a generation in progress, and that is asserted
-- against every real event on every gate run. A worker that settles wrongly breaks it visibly.

alter table ai_jobs add column if not exists reserved_usd numeric;
alter table ai_jobs add column if not exists spent_usd numeric not null default 0;
alter table ai_jobs add column if not exists generations_charged integer not null default 0;

comment on column ai_jobs.reserved_usd is
  'The reservation this job is holding right now, or null when it holds none. Set before the paid call, released by settle_job.';
comment on column ai_jobs.spent_usd is
  'What this job has actually cost, accumulated across attempts. A retry that pays again adds again.';
comment on column ai_jobs.generations_charged is
  'How many of the event''s generations this job has genuinely consumed.';

/* --------------------------------------------------------------- taking the reservation */

-- The single place a job takes money. consume_generation is still the one statement that
-- charges the event (it is atomic against two workers racing, and phase 3 proves it); this
-- wraps it so the job records what it is holding.
create or replace function reserve_generation(p_job_id uuid, p_estimated_cost_usd numeric)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $function$
declare v_event uuid; v_held numeric; v_ok boolean;
begin
  select event_id, reserved_usd into v_event, v_held from ai_jobs where id = p_job_id;
  if v_event is null then
    raise exception 'UNKNOWN_JOB' using hint = 'No AI job with that id.';
  end if;

  -- Idempotent within an attempt: a job already holding a reservation does not take a second
  -- one. A worker that retried its own reserve call would otherwise charge the event twice
  -- for one generation.
  if v_held is not null then return true; end if;

  v_ok := consume_generation(v_event, p_estimated_cost_usd);
  if not v_ok then return false; end if;

  update ai_jobs
     set reserved_usd = greatest(0, coalesce(p_estimated_cost_usd, 0)), updated_at = now()
   where id = p_job_id;
  return true;
end;
$function$;

/* ------------------------------------------------------------- releasing it, truthfully */

-- p_used_generation is the whole point of this function, so it has no default: the caller is
-- forced to say which side of the paid call it failed on.
--
--   after the model answered  -> used = true,  actual = what it charged
--   before the model answered -> used = false, actual = 0
--
-- "Refund everything on any failure" is the shape that hid the bug; making the caller choose is
-- what makes the choice visible in review.
create or replace function settle_job(p_job_id uuid, p_actual_cost_usd numeric, p_used_generation boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $function$
declare v_event uuid; v_held numeric; v_actual numeric;
begin
  select event_id, reserved_usd into v_event, v_held from ai_jobs where id = p_job_id;
  if v_event is null then return; end if;

  -- Idempotent: a job holding no reservation has already been settled. A retried settle must
  -- not refund a second time — that would be the same class of error in the other direction.
  if v_held is null then return; end if;

  v_actual := greatest(0, coalesce(p_actual_cost_usd, 0));

  update events
     set ai_spend_usd = greatest(0, ai_spend_usd - v_held + v_actual),
         generations_used = case when p_used_generation
                                 then generations_used
                                 else greatest(0, generations_used - 1) end,
         updated_at = now()
   where id = v_event;

  update ai_jobs
     set reserved_usd = null,
         spent_usd = spent_usd + v_actual,
         generations_charged = generations_charged + case when p_used_generation then 1 else 0 end,
         updated_at = now()
   where id = p_job_id;
end;
$function$;

revoke all on function reserve_generation(uuid, numeric) from public, anon, authenticated;
revoke all on function settle_job(uuid, numeric, boolean) from public, anon, authenticated;

/* ----------------------------------------------------------------------------- the gate */

create or replace function gate_ai_refunds()
returns table(area text, check_name text, expected text, actual text, pass boolean)
language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  a uuid; op uuid;
  p1 uuid; p2 uuid; p3 uuid; p4 uuid;
  j1 uuid; j2 uuid; j3 uuid; j4 uuid;
  spend numeric; gens integer; ok boolean; n integer;
  ledger numeric; held numeric; charged integer; outstanding integer;
begin
  perform gate_cleanup();

  insert into events (slug, name, status, ai_budget_usd, ai_est_cost_usd, max_generations, ai_paused)
  values ('gate-money', 'Gate Money', 'live', 1.00, 0.04, 10, false) returning id into a;
  select id into op from api_create_operator(a, 'gatemoney', 'Gate Money', 'A', 'operator', '7272');

  p1 := gen_random_uuid(); p2 := gen_random_uuid();
  p3 := gen_random_uuid(); p4 := gen_random_uuid();
  insert into photos (id, event_id, operator_id, kind, storage_path, thumb_path, bytes, status)
  values (p1, a, op, 'original', 'o/1.jpg', 't/1.jpg', 10, 'ready'),
         (p2, a, op, 'original', 'o/2.jpg', 't/2.jpg', 10, 'ready'),
         (p3, a, op, 'original', 'o/3.jpg', 't/3.jpg', 10, 'ready'),
         (p4, a, op, 'original', 'o/4.jpg', 't/4.jpg', 10, 'ready');

  select id into j1 from api_enqueue_job(a, p1, op);
  select id into j2 from api_enqueue_job(a, p2, op);
  select id into j3 from api_enqueue_job(a, p3, op);
  select id into j4 from api_enqueue_job(a, p4, op);

  /* ---------------------------------- 1. a failure AFTER the model was paid keeps the cost */

  perform reserve_generation(j1, 0.04);
  -- The model answered and charged 0.0375; the upload then failed. The old code refunded this
  -- to zero. The money was already gone.
  perform settle_job(j1, 0.0375, true);

  select ai_spend_usd, generations_used into spend, gens from events where id = a;

  area := 'feature D'; check_name := 'a failure after the model was paid books the real cost, to the cent';
  expected := '0.0375'; actual := spend::text;
  pass := (spend = 0.0375); return next;

  area := 'feature D'; check_name := 'and it does not hand the generation back — we bought it';
  expected := '1'; actual := gens::text; pass := (gens = 1); return next;

  /* ------------------------------- 2. a failure BEFORE the call refunds money AND the count */

  perform reserve_generation(j2, 0.04);
  select ai_spend_usd, generations_used into spend, gens from events where id = a;

  area := 'feature D'; check_name := 'a reservation is taken before the paid call, not after';
  expected := '0.0775 reserved, 2 generations'; actual := spend::text || ', ' || gens::text;
  pass := (spend = 0.0775 and gens = 2); return next;

  perform settle_job(j2, 0, false);
  select ai_spend_usd, generations_used into spend, gens from events where id = a;

  area := 'feature D'; check_name := 'a failure before the call gives back the money';
  expected := '0.0375'; actual := spend::text; pass := (spend = 0.0375); return next;

  area := 'law 4'; check_name := 'and gives back the generation, so retries cannot burn the event''s count';
  expected := '1'; actual := gens::text; pass := (gens = 1); return next;

  /* --------------------------------------------- 3. settling twice does not refund twice */

  perform settle_job(j2, 0, false);
  perform settle_job(j2, 0, false);
  select ai_spend_usd, generations_used into spend, gens from events where id = a;

  area := 'feature D'; check_name := 'settling a job twice refunds once';
  expected := '0.0375, 1'; actual := spend::text || ', ' || gens::text;
  pass := (spend = 0.0375 and gens = 1); return next;

  /* ------------------------------------------------------------------ 4. a real success */

  perform reserve_generation(j3, 0.04);
  perform api_job_succeeded(j3, null, 'gate-model', 91000, 0.052);
  perform settle_job(j3, 0.052, true);
  select ai_spend_usd, generations_used into spend, gens from events where id = a;

  area := 'feature D'; check_name := 'the meter reads money spent, not money reserved';
  expected := '0.0895 — 0.0375 paid for nothing, 0.052 delivered, and no estimates left over';
  actual := spend::text; pass := (spend = 0.0895); return next;

  /* -------------------------------------- 5. and one still in flight: the books still balance */

  -- Reserved, not settled. The invariant has to hold mid-generation or it is only an
  -- end-of-night comfort.
  perform reserve_generation(j4, 0.04);

  select ai_spend_usd, generations_used into spend, gens from events where id = a;
  select coalesce(sum(spent_usd), 0), coalesce(sum(reserved_usd), 0),
         coalesce(sum(generations_charged), 0), count(*) filter (where reserved_usd is not null)
    into ledger, held, charged, outstanding
    from ai_jobs where event_id = a;

  area := 'feature D'; check_name := 'the meter equals what was paid plus what is promised, mid-generation';
  expected := 'spend = paid + reserved';
  actual := spend::text || ' = ' || ledger::text || ' + ' || held::text;
  pass := (spend = ledger + held); return next;

  area := 'law 4'; check_name := 'and the generation count reconciles the same way';
  expected := 'used = charged + outstanding';
  actual := gens::text || ' = ' || charged::text || ' + ' || outstanding::text;
  pass := (gens = charged + outstanding); return next;

  /* ------------------------------------------------ 6. the cap still refuses BEFORE spending */

  update events set ai_budget_usd = spend + 0.01 where id = a;
  ok := reserve_generation(j2, 0.04);

  area := 'feature D'; check_name := 'the cap refuses the next job before a cent of it is spent';
  expected := 'refused, meter unmoved at 0.1295';
  select ai_spend_usd into spend from events where id = a;
  actual := case when ok then 'ALLOWED' else 'refused' end || ', ' || spend::text;
  pass := (not ok and spend = 0.1295); return next;

  area := 'feature D'; check_name := 'a refused job holds no reservation';
  select count(*) into n from ai_jobs where id = j2 and reserved_usd is not null;
  expected := '0'; actual := n::text; pass := (n = 0); return next;

  area := 'feature D'; check_name := 'and the event never ends over its budget';
  select (ai_spend_usd <= ai_budget_usd) into ok from events where id = a;
  expected := 'true'; actual := coalesce(ok::text, '(gone)'); pass := (ok is true); return next;

  perform gate_cleanup();

  /* ------------------------------- 7. the same books, checked against every real event */

  -- The checks above run on a fixture, which proves the arithmetic. This one proves the LIVE
  -- data obeys it — so a worker deploy that settles the old way is caught here rather than at
  -- the end of an event, when the number is already wrong and the money is already gone.
  area := 'feature D'; check_name := 'every real event''s books balance too';
  select count(*) into n
    from events e
   where e.ai_spend_usd is distinct from (
           select coalesce(sum(j.spent_usd), 0) + coalesce(sum(j.reserved_usd), 0)
             from ai_jobs j where j.event_id = e.id);
  expected := '0 events out of balance'; actual := n::text || ' out of balance';
  pass := (n = 0); return next;

  area := 'law 4'; check_name := 'and every real event''s generation count balances';
  select count(*) into n
    from events e
   where e.generations_used is distinct from (
           select coalesce(sum(j.generations_charged), 0)
                  + count(*) filter (where j.reserved_usd is not null)
             from ai_jobs j where j.event_id = e.id);
  expected := '0 events out of balance'; actual := n::text || ' out of balance';
  pass := (n = 0); return next;

  return;
end;
$function$;

revoke all on function gate_ai_refunds() from public, anon, authenticated;

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
    raise exception 'GATE_SUITE_RED after 0037 (% checks): %', total, bad;
  end if;
  raise notice 'gate suite green: % checks', total;
end $$;
