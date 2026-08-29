-- 0026_branding_public.sql
--
-- Feature A's last data-layer piece: the walls can know the event's logo. 0012 gave events a
-- brand_logo_path and api_set_event_branding writes it, but the public event shape from 0019
-- never carried it, so no wall could render what the admin uploaded. The shape gains exactly
-- that one column - and the gate re-proves, permanently, that widening it did NOT let the AI
-- prompt, budgets or spend leak into what an unauthenticated wall may know.
--
-- The status lifecycle (draft -> live -> archived, nothing backwards, archived terminal) has
-- been enforced by trigger since 0012; it gains its executable check here, alongside the
-- feature A checks, so the admin console being able to move status is backed by proof that
-- the database refuses the moves the lifecycle forbids.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

drop function if exists api_event_public(text);

create function api_event_public(p_event_slug text)
returns table (
  slug text, name text, name_ar text, name_en text, status text,
  locale_default text, locales text[],
  brand_primary text, brand_secondary text, brand_font_family text,
  brand_logo_path text,
  wall_frozen boolean, panic_brand_only boolean,
  banner_active boolean, banner_text_en text, banner_text_ar text,
  guest_mode text, wall_config jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.slug, e.name, e.name_ar, e.name_en, e.status,
         e.locale_default, e.locales,
         e.brand_primary, e.brand_secondary, e.brand_font_family,
         e.brand_logo_path,
         e.wall_frozen, e.panic_brand_only,
         e.banner_active, e.banner_text_en, e.banner_text_ar,
         e.guest_mode, e.wall_config
    from events e
   where e.slug = p_event_slug;
$$;

comment on function api_event_public(text) is
  'The whole of what a wall or guest surface may know about an event. AI prompt, budgets and spend are structurally absent: not in the return type.';

/* ----------------------------------------------------- feature A, proven and kept proven */

create or replace function gate_branding()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  a uuid; n integer; t text; ok boolean;
begin
  perform gate_cleanup();

  area := 'feature A'; check_name := 'the public shape carries the brand logo for the walls';
  select pg_get_function_result(p.oid) into t
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'api_event_public';
  expected := 'brand_logo_path present'; actual := left(coalesce(t, '(missing)'), 60);
  pass := (t is not null and t ~* 'brand_logo_path'); return next;

  area := 'law 5'; check_name := 'widening the shape leaked nothing: AI config still absent';
  expected := 'no ai_prompt, budget or spend';
  actual := case when t ~* '(ai_prompt|budget|spend)' then 'LEAKED' else 'absent' end;
  pass := (t is not null and t !~* '(ai_prompt|budget|spend)'); return next;

  insert into events (slug, name, status) values ('gate-a-life', 'Gate Lifecycle', 'draft')
  returning id into a;

  area := 'feature A'; check_name := 'a draft event goes live';
  perform api_update_event('gate-a-life', null, null, null, null, 'live', null);
  select status into t from events where id = a;
  expected := 'live'; actual := t; pass := (t = 'live'); return next;

  area := 'feature A'; check_name := 'nothing goes backwards from live';
  begin
    perform api_update_event('gate-a-life', null, null, null, null, 'draft', null);
    ok := false;
  exception when others then ok := (sqlerrm = 'ILLEGAL_STATUS_TRANSITION');
  end;
  expected := 'refused'; actual := case when ok then 'refused' else 'ALLOWED' end;
  pass := ok; return next;

  area := 'feature A'; check_name := 'archived is terminal';
  perform api_update_event('gate-a-life', null, null, null, null, 'archived', null);
  begin
    perform api_update_event('gate-a-life', null, null, null, null, 'live', null);
    ok := false;
  exception when others then ok := (sqlerrm = 'ILLEGAL_STATUS_TRANSITION');
  end;
  expected := 'refused'; actual := case when ok then 'refused' else 'ALLOWED' end;
  pass := ok; return next;

  area := 'feature A'; check_name := 'branding lands on the row the admin named';
  perform api_set_event_branding(a, 'Gate EN', 'بوابة', 'ar', null, '#112233', '#445566',
                                 'gate/brand/logo.png', null, null, null);
  select count(*) into n from events
   where id = a and brand_primary = '#112233' and brand_logo_path = 'gate/brand/logo.png'
     and name_ar = 'بوابة';
  expected := '1'; actual := n::text; pass := (n = 1); return next;

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
    from gate_branding() g;
$$;

select apply_function_grants();

do $$
declare v_fails integer;
begin
  select count(*) into v_fails from run_all_gates() where not pass;
  if v_fails > 0 then
    raise exception 'gate suite red after 0026: % failing check(s)', v_fails;
  end if;
end
$$;