-- 0009_schema_lock_assertion_fix.sql
--
-- assert_schema_locked() was created by 0008 but could not run: `n.nspname::text || ' (' ||
-- d.defaclobjtype || ')'` is ambiguous, because defaclobjtype is "char" and Postgres cannot
-- choose between the text || "char" candidates. The body was never parsed at creation
-- because 0008 inherited `set check_function_bodies = off` from the earlier migrations.
--
-- A backstop that raises an error the moment you call it is worse than no backstop, because
-- it reads as green until someone actually runs it. This migration fixes the cast, renders
-- the PUBLIC pseudo-role correctly, and then CALLS the function - so applying this migration
-- is itself proof that the assertion executes and that the schema is locked.
--
-- check_function_bodies is deliberately left ON here so the body is parsed at creation.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

create or replace function assert_schema_locked()
returns table (violation text, object_name text, detail text)
language sql stable security definer set search_path = public, pg_catalog, pg_temp
as $$
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
$$;

comment on function assert_schema_locked() is
  'Returns one row per structural violation. Zero rows is the invariant. The phase gate fails on any row.';

select apply_function_grants();

-- Applying this migration proves the assertion runs and the invariant holds.
do $$
declare
  v_count integer;
  v_first text;
begin
  select count(*) into v_count from assert_schema_locked();
  if v_count > 0 then
    select violation || ' on ' || object_name || ' - ' || detail
      into v_first from assert_schema_locked() limit 1;
    raise exception 'schema lock assertion failed with % violation(s); first: %', v_count, v_first;
  end if;
  raise notice 'assert_schema_locked: clean';
end
$$;
