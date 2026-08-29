-- 0017_gate_suite_dispatcher.sql
--
-- Law 13 says the regression suite GROWS phase by phase and re-runs before every later phase
-- report. That needs a shape, decided now rather than improvised at Phase 4.
--
--   Each phase adds its own gate function returning the same four columns. Nothing rewrites an
--   earlier one, which keeps the append-only rule that governs migrations governing the tests
--   too. run_all_gates() is the single entry point, and each phase ships a new version of it
--   that unions in the gate it added.
--
-- This migration also adds the Phase 0 checks that 0016 made possible: capture provenance is
-- recorded, and a retry cannot rewrite it.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

create or replace function gate_phase_0_capture()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  a uuid; opA uuid; ph uuid; t text; n integer;
begin
  perform gate_cleanup();

  insert into events (slug, name, status) values ('gate-capture', 'Gate Capture', 'live')
  returning id into a;
  select id into opA from api_create_operator(a, 'gatecap', 'Gate Cap', 'A', 'operator', '5150');

  ph := gen_random_uuid();
  perform api_upsert_photo_if_absent(
    ph, a, opA, 'original', 'o/cap.jpg', 't/cap.jpg', 100,
    'tablet-77', now() - interval '20 minutes', 'booth', 'restyle');

  area := 'feature C'; check_name := 'the per-shot restyle choice is recorded';
  select restyle_intent into t from photos where id = ph;
  expected := 'restyle'; actual := coalesce(t, '(null)'); pass := (t = 'restyle'); return next;

  area := 'feature C'; check_name := 'the capturing device is recorded';
  select device_id into t from photos where id = ph;
  expected := 'tablet-77'; actual := coalesce(t, '(null)'); pass := (t = 'tablet-77'); return next;

  area := 'law 1'; check_name := 'the time the shutter fired is kept, not the time it arrived';
  select case when client_captured_at < created_at - interval '5 minutes'
              then 'earlier than arrival' else 'same as arrival' end
    into t from photos where id = ph;
  expected := 'earlier than arrival'; actual := coalesce(t, '(null)');
  pass := (t = 'earlier than arrival'); return next;

  -- A retry from an outbox re-sends the whole capture. It must not be able to rewrite what
  -- already landed, or a replayed stale request could relabel a shot mid-event.
  perform api_upsert_photo_if_absent(
    ph, a, opA, 'original', 'o/OVERWRITTEN.jpg', 't/OVERWRITTEN.jpg', 999,
    'attacker', now(), 'import', 'straight');

  area := 'law 1'; check_name := 'a retry cannot rewrite the provenance of a landed shot';
  select device_id || '/' || restyle_intent || '/' || storage_path into t from photos where id = ph;
  expected := 'tablet-77/restyle/o/cap.jpg'; actual := coalesce(t, '(null)');
  pass := (t = 'tablet-77/restyle/o/cap.jpg'); return next;

  area := 'law 1'; check_name := 'and it is still exactly one photo';
  select count(*) into n from photos where id = ph;
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  perform gate_cleanup();
  return;
end;
$$;

/* -------------------------------------------------------------- the single entry point
 * Every phase from here appends its gate to this union and nothing else changes. A red row
 * anywhere blocks the next phase.
 */

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
    from gate_phase_0_capture() g;
$$;

comment on function run_all_gates() is
  'Law 13. The whole regression suite, every phase, one call: select * from run_all_gates(). Each phase appends; nothing is ever rewritten.';

select apply_function_grants();

do $$
declare v_count integer;
begin
  select count(*) into v_count from assert_schema_locked();
  if v_count > 0 then
    raise exception 'schema lock assertion failed with % violation(s) after 0017', v_count;
  end if;
end
$$;
