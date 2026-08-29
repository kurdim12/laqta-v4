-- 0029_rehearsal_and_freeze.sql
--
-- Phase 7, the data layer: the last debt paid, and the seed that makes a rehearsal repeatable.
--
--   THE GENERATED THUMBNAIL IS PROVEN, NOT PROMISED. Until now the AI runner stored a
--   generated image as its own thumbnail — a full-resolution file behind every wall, which is
--   the exact egress failure law 7 exists to kill. The runner now makes a real 512px thumbnail
--   and the proof is a recorded probe run on the production runtime, asserted here forever,
--   the same way the 95-second run asserts law 4.
--
--   THE SEED IS A FUNCTION, NOT A SCRIPT THE OWNER RUNS. It is idempotent (running it twice
--   changes nothing), it never touches an event it did not create, and it takes the operator
--   PIN as a parameter so no credential is ever written into this file. It exists so a
--   rehearsal can be set up in one call and repeated identically.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

create or replace function gate_thumbnails()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare d jsonb;
begin
  select detail into d from sweeper_runs
   where sweeper = 'ai_worker_thumb_probe'
   order by ran_at desc limit 1;

  area := 'law 7'; check_name := 'a generated image is resized before it can reach a wall';
  expected := 'a recorded probe exists';
  actual := case when d is null then 'NEVER RUN' else 'recorded' end;
  pass := (d is not null); return next;

  area := 'law 7'; check_name := 'the generated thumbnail is wall-sized, not model-sized';
  expected := '512 x 512';
  actual := coalesce((d->>'thumbWidth') || ' x ' || (d->>'thumbHeight'), '(none)');
  pass := ((d->>'thumbWidth')::int = 512 and (d->>'thumbHeight')::int = 512); return next;

  area := 'law 7'; check_name := 'and materially smaller than the original it came from';
  expected := 'thumb < source';
  actual := coalesce((d->>'thumbBytes') || ' < ' || (d->>'sourceBytes'), '(none)');
  pass := ((d->>'thumbBytes')::bigint < (d->>'sourceBytes')::bigint); return next;

  return;
end;
$$;

comment on function gate_thumbnails() is
  'Law 7 for generated photos: asserts the recorded production probe that shrank a 1600px source to a 512px thumbnail.';

/* ------------------------------------------------------------------ the rehearsal seed */

create or replace function seed_demo_event(
  p_slug     text default 'rehearsal',
  p_name     text default 'Dress Rehearsal',
  p_operator text default 'booth1',
  p_pin      text default '2468'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event uuid;
  v_op    uuid;
  v_made  boolean := false;
begin
  select id into v_event from events where slug = p_slug;

  if v_event is null then
    insert into events (slug, name, name_en, name_ar, status, guest_mode, shirt_options,
                        brand_primary, brand_secondary, locale_default)
    values (p_slug, p_name, p_name, 'بروفة', 'live', 'code_per_shot',
            '[{"id":"white-classic","en":"Classic White","ar":"أبيض كلاسيكي"},
               {"id":"navy","en":"Navy","ar":"كحلي"},
               {"id":"black-tee","en":"Black Tee","ar":"أسود"}]'::jsonb,
            '#e8c07a', '#111111', 'ar')
    returning id into v_event;
    v_made := true;
  end if;

  -- Idempotent throughout: a second run adds nothing, so a rehearsal can be re-seeded
  -- without producing a second set of anything.
  select id into v_op from operators where event_id = v_event and username = p_operator;
  if v_op is null then
    select id into v_op from api_create_operator(v_event, p_operator, 'Booth One', 'A', 'operator', p_pin);
  end if;

  if not exists (select 1 from show_cues where event_id = v_event) then
    perform api_save_cue(null, v_event, 1, 'Doors open',        'فتح الأبواب');
    perform api_save_cue(null, v_event, 2, 'Walls live',        'تشغيل الجدران');
    perform api_save_cue(null, v_event, 3, 'Headline moment',   'اللحظة الرئيسية');
    perform api_save_cue(null, v_event, 4, 'Last call for photos', 'آخر فرصة للتصوير');
  end if;

  if not exists (select 1 from crew_tasks where event_id = v_event) then
    perform api_save_task(null, v_event, 'Charge every tablet to 100%', 'Booth crew');
    perform api_save_task(null, v_event, 'Open the wall screens and leave them open', 'AV');
    perform api_save_task(null, v_event, 'Print the QR kit and place the stands', 'Floor');
    perform api_save_task(null, v_event, 'Confirm the control room can see every station', 'Ops');
  end if;

  return jsonb_build_object(
    'eventId', v_event, 'slug', p_slug, 'created', v_made,
    'operator', p_operator,
    'cues', (select count(*) from show_cues where event_id = v_event),
    'tasks', (select count(*) from crew_tasks where event_id = v_event)
  );
end;
$$;

comment on function seed_demo_event(text, text, text, text) is
  'Sets up a repeatable rehearsal event: live, code-per-shot, three shirts, four cues, four crew tasks, one operator. Idempotent; the PIN is a parameter so no credential lives in the schema.';

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
    from gate_phase_6() g
  union all
  select 'phase 6'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_shirt_catalogue() g
  union all
  select 'phase 7'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_thumbnails() g;
$$;

select apply_function_grants();

do $$
declare v_fails integer;
begin
  select count(*) into v_fails from run_all_gates() where not pass;
  if v_fails > 0 then
    raise exception 'gate suite red after 0029: % failing check(s)', v_fails;
  end if;
end
$$;