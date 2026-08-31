-- 0034_no_null_verdicts.sql
--
-- The storage self-test found a real defect in the product, and in finding it exposed a defect
-- in the gate suite itself.
--
--   THE PRODUCT BUG. Signing an upload URL for an object that ALREADY EXISTS is refused by
--   Supabase Storage. That is the retry path, not an edge case: the outbox re-asks for upload
--   URLs every time it retries, so a photo whose bytes landed but whose register call failed
--   would be refused at the signing step forever - the failure sitting one layer above the PUT,
--   where 0033's tolerance had been added. Fixed in the API layer with x-upsert.
--
--   THE GATE BUG, which is worse. gate_storage() returned `pass = null` for the check that
--   never ran, and `count(*) where not pass` does not count a null: a check with no verdict
--   silently vanished from the failure count instead of failing. Every gate here is written the
--   same way, so the hole exists anywhere a check might produce a null. A test that can quietly
--   decline to have an opinion is not a test.
--
-- Every verdict is now coerced: null is FALSE, because a check that reached no conclusion has
-- not passed. This is the third time this suite has been narrower than its own claim (law 9
-- counted only one schema; law 6 asked "is it hashed" but not "is it readable"), and the shape
-- is the same each time: the check tested what was built, not what was missed.
--
-- THE SPLIT. run_gate_checks() is every gate. run_all_gates() is that plus the suite's check on
-- itself. They are two functions because the first attempt made gate_suite_integrity() a member
-- of the union it queries, which recursed until the migration timed out - caught, as ever, by a
-- transaction that rolled the whole thing back rather than leaving half of it applied.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

create or replace function run_gate_checks()
returns table (phase text, area text, check_name text, expected text, actual text, pass boolean)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
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
  union all select 'audit'::text,   g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_storage() g;
$$;

comment on function run_gate_checks() is
  'Every gate in the suite, with null verdicts coerced to false. run_all_gates() adds the suite''s check on itself.';

create or replace function gate_suite_integrity()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare n integer;
begin
  -- Queries run_gate_checks(), never run_all_gates(): a self-check that included itself would
  -- recurse forever, which is exactly how the first version of this migration failed.
  area := 'law 13'; check_name := 'no gate check returns a verdict of neither pass nor fail';
  select count(*) into n from run_gate_checks() g where g.pass is null;
  expected := '0 null verdicts'; actual := n::text; pass := (n = 0); return next;

  area := 'law 13'; check_name := 'every gate check names what it expected and what it found';
  select count(*) into n from run_gate_checks() g
   where coalesce(btrim(g.expected), '') = '' or coalesce(btrim(g.actual), '') = '';
  expected := '0 silent checks'; actual := n::text; pass := (n = 0); return next;

  return;
end;
$$;

comment on function gate_suite_integrity() is
  'The suite checking itself: a gate that returns no verdict, or reports neither an expectation nor a finding, is not evidence of anything.';

create or replace function run_all_gates()
returns table (phase text, area text, check_name text, expected text, actual text, pass boolean)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select g.phase, g.area, g.check_name, g.expected, g.actual, g.pass from run_gate_checks() g
  union all
  select 'audit'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false)
    from gate_suite_integrity() g;
$$;

comment on function run_all_gates() is
  'Law 13. Every gate, plus the suite''s check on itself. A null verdict counts as a failure.';

select apply_function_grants();

do $$
declare v_fails integer;
begin
  select count(*) into v_fails from run_all_gates() where not pass;
  if v_fails > 0 then
    raise exception 'gate suite red after 0034: % failing check(s)', v_fails;
  end if;
end
$$;
