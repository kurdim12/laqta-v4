-- 0030_reachability_boundary.sql
--
-- A pre-freeze audit went looking outside where the law had been looking, and found that
-- law 9's proof was narrower than its claim.
--
-- WHAT WAS FOUND. The gate check "the public anon key can execute nothing" counts routines in
-- the `public` schema. Two extensions live elsewhere and ship their grants to PUBLIC, which
-- every role inherits: `net` (pg_net — an HTTP request emitter, plus a queue table anon holds
-- every privilege on) and `cron` (pg_cron — the scheduler). By EXECUTE alone, the anon role
-- can call `net.http_post` and `cron.schedule`.
--
-- WHAT IS ACTUALLY REACHABLE. Nothing. Two independent reasons, both verified rather than
-- assumed:
--
--   * PostgREST resolves RPC only inside its exposed schema. A live request to this project's
--     own API carrying the real anon key — POST /rest/v1/rpc/http_post — came back
--     404 PGRST202, "Searched for the function public.http_post ... no matches were found".
--     The `net` schema is not addressable by the key that ships in the browser bundle. That
--     response is recorded in sweeper_runs as 'anon_reachability_probe' and asserted below.
--   * The `cron` schema additionally denies anon USAGE outright, so its EXECUTE grant is
--     unreachable twice over.
--
-- WHAT COULD NOT BE FIXED, AND WHY IT IS SAID PLAINLY. Those grants belong to supabase_admin.
-- This project's postgres role is not a member of supabase_admin, so it cannot revoke them —
-- an earlier draft of this migration tried, and its own pre-commit assertion caught that the
-- revoke had silently changed nothing and rolled the whole thing back rather than let a fix be
-- claimed that had not happened. The residual is therefore a platform default, not a decision
-- of ours, and the mitigation that IS ours is the one thing that must never change: the
-- exposed-schema list stays `public` (plus graphql_public). That is now written in the runbook
-- as a freeze invariant.
--
-- WHAT THIS MIGRATION DOES. It makes the boundary explicit and permanently checked: the
-- assertion gains the rule we CAN hold — nothing of ours ever lives outside `public` — and the
-- gate asserts the recorded reachability probe alongside it, so a change to the exposed-schema
-- list is caught the next time the probe is re-run rather than discovered during an event.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

create or replace function assert_schema_locked()
returns table (violation text, object_name text, detail text)
language sql
stable
security definer
set search_path to 'public', 'pg_catalog', 'pg_temp'
as $function$
  -- a table in public without row level security
  select 'rls_disabled', c.relname::text, 'table in public has RLS switched off'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity

  union all
  -- Any privilege held by a public-facing role on a table or sequence. The ACL is read
  -- directly: information_schema.role_table_grants only reports roles the caller belongs to,
  -- so it can miss a grant entirely. This check is deliberately unconditional on who created
  -- the object, which is what makes it the real backstop: supabase_admin's default privileges
  -- in public still grant to anon and cannot be revoked by postgres, so if anything ever
  -- creates a table as that role, this is what catches it.
  select 'anon_grant', c.relname::text,
         'grants to ' || (case when a.grantee = 0 then 'PUBLIC'
                               else pg_get_userbyid(a.grantee) end)
                      || ': ' || string_agg(a.privilege_type, ', ')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relkind in ('r', 'S', 'p')
     and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
   group by c.relname, a.grantee

  union all
  -- a routine the anon key could execute
  select 'anon_execute', p.oid::regprocedure::text, 'executable by ' || r.rolname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (select unnest(array['anon', 'authenticated']) as rolname) r
   where n.nspname = 'public'
     and has_function_privilege(r.rolname, p.oid, 'EXECUTE')

  union all
  -- ADDED BY 0030. The rule the audit turned into a law: nothing of ours lives outside
  -- `public`. Every routine this system owns is inside the one schema whose grants we control
  -- and whose exposure we intend; anything of ours appearing in net, cron or extensions would
  -- be sitting behind grants belonging to supabase_admin, which we cannot revoke.
  select 'our_routine_outside_public', p.oid::regprocedure::text,
         'owned by ' || pg_get_userbyid(p.proowner) || ' in schema ' || n.nspname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('net', 'cron', 'extensions')
     and pg_get_userbyid(p.proowner) = 'postgres'
     -- An extension's own routines are not ours: pgcrypto lands in `extensions` owned by
     -- whoever ran `create extension`, and that is a deliberate, pinned install (0001, 0007),
     -- not a hand-written function sitting outside the API schema. The rule is about what we
     -- write, so extension members are excluded by their dependency, not by name.
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')

  union all
  -- A security definer function whose search_path is not pinned. create or replace replaces
  -- a function's configuration wholesale, so 0007's pinning is a snapshot that a careless
  -- later migration can silently undo, and no event trigger can stop it without superuser.
  select 'unpinned_search_path', p.oid::regprocedure::text,
         'security definer without a set search_path'
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and (p.proconfig is null
          or not exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search\_path=%'))

  union all
  -- The faucet itself, re-opened. Scoped to the postgres grantor because that is the one
  -- our migrations create objects under, and the only one postgres is permitted to alter.
  select 'open_default_privileges',
         n.nspname::text || ' (' || d.defaclobjtype::text || ')',
         'default privileges under postgres still grant to a public-facing role'
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
   where n.nspname = 'public'
     and pg_get_userbyid(d.defaclrole) = 'postgres'
     and d.defaclacl::text ~ '(anon|authenticated)=';
$function$;

comment on function assert_schema_locked() is
  'The executable backstop for laws 6, 7 and 9: RLS, table grants, anon EXECUTE, nothing of ours outside public, pinned search_path, and the default-privilege faucet.';

create or replace function gate_reachability()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare n integer; d jsonb;
begin
  area := 'law 9'; check_name := 'the anon key can execute nothing in the API schema';
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  expected := '0 callable'; actual := n::text; pass := (n = 0); return next;

  area := 'law 9'; check_name := 'nothing of ours lives outside the API schema';
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname in ('net', 'cron', 'extensions')
     and pg_get_userbyid(p.proowner) = 'postgres'
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');
  expected := '0 hand-written routines'; actual := n::text; pass := (n = 0); return next;

  area := 'law 9'; check_name := 'the scheduler is not even visible to a browser-held key';
  expected := 'no usage on cron';
  actual := case when has_schema_privilege('anon', 'cron', 'USAGE')
                  or has_schema_privilege('authenticated', 'cron', 'USAGE')
                 then 'VISIBLE' else 'no usage on cron' end;
  pass := not (has_schema_privilege('anon', 'cron', 'USAGE')
            or has_schema_privilege('authenticated', 'cron', 'USAGE'));
  return next;

  -- The measured boundary, not the assumed one: a live request carrying the real anon key,
  -- asking this project's own API for a function outside `public`.
  select detail into d from sweeper_runs
   where sweeper = 'anon_reachability_probe' order by ran_at desc limit 1;

  area := 'law 9'; check_name := 'a live anon request for a routine outside public was refused';
  expected := '404 (PGRST202: searched public, no match)';
  actual := coalesce((d->>'statusCode') || ' ' || coalesce(d->>'postgrestCode', ''), 'NEVER PROBED');
  pass := (d is not null and (d->>'statusCode')::int = 404 and d->>'postgrestCode' = 'PGRST202');
  return next;

  area := 'structure'; check_name := 'the schema lock assertion is clean';
  select count(*) into n from assert_schema_locked();
  expected := '0 violations'; actual := n::text; pass := (n = 0); return next;

  return;
end;
$$;

comment on function gate_reachability() is
  'Law 9 measured rather than assumed: what anon may execute, that nothing of ours sits outside public, and the recorded live probe showing the API resolves only inside public.';

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
    from gate_thumbnails() g
  union all
  select 'phase 7'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_reachability() g;
$$;

select apply_function_grants();

do $$
declare v_fails integer;
begin
  select count(*) into v_fails from run_all_gates() where not pass;
  if v_fails > 0 then
    raise exception 'gate suite red after 0030: % failing check(s)', v_fails;
  end if;
end
$$;