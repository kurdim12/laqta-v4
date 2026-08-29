-- 0028_shirt_catalogue_setter.sql
--
-- 0027 gave events a shirt catalogue and the public shape offers it; this is the writer the
-- admin console uses, and it validates rather than trusting: the catalogue must be an array
-- of objects that each carry a non-empty id, because the id is what a photo's style_choice
-- records and a shot pointing at a nameless option is a shot nobody can explain later.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

create or replace function api_set_event_shirts(p_event_id uuid, p_shirt_options jsonb)
returns setof events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_opts jsonb := coalesce(p_shirt_options, '[]'::jsonb);
begin
  if jsonb_typeof(v_opts) <> 'array' then
    raise exception 'SHIRT_OPTIONS_NOT_A_LIST'
      using hint = 'The catalogue is a list of {id, en, ar} objects.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_opts) o
     where jsonb_typeof(o) <> 'object'
        or coalesce(btrim(o->>'id'), '') = ''
  ) then
    raise exception 'SHIRT_OPTION_NEEDS_ID'
      using hint = 'Every option needs an id: it is what a photo records as its choice.';
  end if;

  return query
    update events set shirt_options = v_opts, updated_at = now()
     where id = p_event_id
    returning *;
end;
$$;

comment on function api_set_event_shirts(uuid, jsonb) is
  'Writes the shirt picker''s per-event catalogue, refusing options without an id — the id is what a photo''s style_choice records.';

create or replace function gate_shirt_catalogue()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare a uuid; n integer; ok boolean;
begin
  perform gate_cleanup();
  insert into events (slug, name, status) values ('gate-shirt', 'Gate Shirt', 'live') returning id into a;

  area := 'feature I'; check_name := 'a catalogue with ids is accepted';
  perform api_set_event_shirts(a, '[{"id":"navy","en":"Navy","ar":"كحلي"}]'::jsonb);
  select jsonb_array_length(shirt_options) into n from events where id = a;
  expected := '1'; actual := coalesce(n::text, '(none)'); pass := (n = 1); return next;

  area := 'feature I'; check_name := 'an option without an id is refused';
  begin
    perform api_set_event_shirts(a, '[{"en":"Nameless"}]'::jsonb);
    ok := false;
  exception when others then ok := (sqlerrm = 'SHIRT_OPTION_NEEDS_ID');
  end;
  expected := 'refused'; actual := case when ok then 'refused' else 'ALLOWED' end;
  pass := ok; return next;

  area := 'feature I'; check_name := 'the refused write changed nothing';
  select jsonb_array_length(shirt_options) into n from events where id = a;
  expected := '1'; actual := coalesce(n::text, '(none)'); pass := (n = 1); return next;

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
    from gate_phase_6() g
  union all
  select 'phase 6'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_shirt_catalogue() g;
$$;

select apply_function_grants();

do $$
declare v_fails integer;
begin
  select count(*) into v_fails from run_all_gates() where not pass;
  if v_fails > 0 then
    raise exception 'gate suite red after 0028: % failing check(s)', v_fails;
  end if;
end
$$;