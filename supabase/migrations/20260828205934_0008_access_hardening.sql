-- 0008_access_hardening.sql
--
-- Closes the structural holes the Phase 0 audit found in 0001-0007. Every item here was
-- verified alive against the live database before this migration was written; see
-- docs/phase-0-gap.md.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

set check_function_bodies = off;

/* ------------------------------------------------------------------ A. the faucet
 * pg_default_acl granted anon and authenticated FULL privileges on every NEW table,
 * sequence and function created in schema public. The six tables of 0001 are safe only
 * because RLS is enabled on each of them. Phase 0 adds roughly fifteen more, several
 * holding guest PII, so "remember to enable RLS" is not an acceptable defence.
 *
 * Supabase does not grant superuser, so a ddl_command_end event trigger is unavailable.
 * Shutting the faucet is therefore the structural fix: a new table arrives with no grant
 * to anon at all, so a forgotten RLS enable is no longer catastrophic. assert_schema_locked()
 * at the bottom of this file is the executable backstop, and the phase gate calls it.
 */

alter default privileges in schema public revoke all     on tables    from anon, authenticated, public;
alter default privileges in schema public revoke all     on sequences from anon, authenticated, public;
-- PUBLIC is included deliberately: Postgres' own built-in default grants EXECUTE on every
-- new function to PUBLIC, which anon is a member of. Revoking only the two named roles
-- would leave that path open.
alter default privileges in schema public revoke execute on routines  from anon, authenticated, public;

-- Objects created by supabase_admin carry a second, separate default. postgres is not a
-- member of that role on a managed project, so this is best-effort and must not fail the
-- migration: it governs Supabase's own internal objects, not ours.
do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public revoke all     on tables    from anon, authenticated, public';
  execute 'alter default privileges for role supabase_admin in schema public revoke all     on sequences from anon, authenticated, public';
  execute 'alter default privileges for role supabase_admin in schema public revoke execute on routines  from anon, authenticated, public';
exception when others then
  raise notice 'default privileges for supabase_admin left unchanged (%): postgres is not a member of that role', sqlerrm;
end
$$;

/* --------------------------------------------------- B. one API layer, one credential
 * Law 9 says exactly one API layer. wall_photos was the single exception: the only
 * function the public anon key could execute. From here the anon key can reach nothing
 * at all - every surface, walls included, goes through the Edge Function API layer, which
 * holds the service-role key. That also closes the slug-guessing path into wall_photos,
 * since events.slug is only ^[a-z0-9-]{3,40}$.
 *
 * USAGE on the schema is deliberately left in place: without object privileges it grants
 * nothing, and revoking it produces confusing errors in Supabase's own tooling.
 */

revoke all     on all tables    in schema public from anon, authenticated;
revoke all     on all sequences in schema public from anon, authenticated;
revoke execute on all routines  in schema public from anon, authenticated, public;

/* -------------------------------------------------- C. the grant helper, made complete
 * apply_function_grants() filtered prokind = 'f', so procedures, aggregates and window
 * functions kept the default anon EXECUTE grant. It also never revoked from PUBLIC.
 */

-- The 0004 version returned void, and a return type cannot be changed in place.
drop function if exists apply_function_grants();

create function apply_function_grants()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.prokind in ('f', 'p', 'a', 'w')
  loop
    execute format('revoke execute on routine %s from public, anon, authenticated', r.sig);
    execute format('grant  execute on routine %s to service_role', r.sig);
    n := n + 1;
  end loop;
  return n;
end;
$$;

comment on function apply_function_grants() is
  'Every routine in public is service_role only. Re-run after adding functions; the phase gate asserts it.';

/* --------------------------------------------- D. the credential stops being returned
 * api_operator_by_id, api_list_operators, api_create_operator and api_set_operator_pin
 * all declared "returns setof operators", and that composite type carries pin_hash. A
 * short numeric PIN behind a published bcrypt hash is an offline crack, not a secret.
 *
 * A return-type change cannot be done with create or replace, so each is dropped first.
 * The column list is spelled out so that adding a column to operators later can never
 * silently widen these again.
 */

drop function if exists api_operator_by_id(uuid);
drop function if exists api_list_operators(uuid);
drop function if exists api_create_operator(uuid, text, text, text, text, text);
drop function if exists api_set_operator_pin(uuid, text);

create function api_operator_by_id(p_operator_id uuid)
returns table (
  id uuid, event_id uuid, username text, display_name text,
  booth text, role text, active boolean, last_seen_at timestamptz, created_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select o.id, o.event_id, o.username, o.display_name,
         o.booth, o.role, o.active, o.last_seen_at, o.created_at
    from operators o where o.id = p_operator_id;
$$;

create function api_list_operators(p_event_id uuid)
returns table (
  id uuid, event_id uuid, username text, display_name text,
  booth text, role text, active boolean, last_seen_at timestamptz, created_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select o.id, o.event_id, o.username, o.display_name,
         o.booth, o.role, o.active, o.last_seen_at, o.created_at
    from operators o where o.event_id = p_event_id order by o.booth, o.username;
$$;

create function api_create_operator(
  p_event_id uuid, p_username text, p_display_name text,
  p_booth text, p_role text, p_pin text
)
returns table (
  id uuid, event_id uuid, username text, display_name text,
  booth text, role text, active boolean, last_seen_at timestamptz, created_at timestamptz
)
language sql security definer set search_path = public, extensions, pg_temp
as $$
  insert into operators (event_id, username, display_name, booth, role, pin_hash)
  values (p_event_id, p_username, p_display_name, p_booth, p_role,
          crypt(p_pin, gen_salt('bf')))
  returning operators.id, operators.event_id, operators.username, operators.display_name,
            operators.booth, operators.role, operators.active, operators.last_seen_at,
            operators.created_at;
$$;

-- Setting a PIN returns nothing at all. There is no caller that needs the row back, and
-- returning it is how the hash leaked in the first place.
create function api_set_operator_pin(p_operator_id uuid, p_pin text)
returns void
language sql security definer set search_path = public, extensions, pg_temp
as $$
  update operators set pin_hash = crypt(p_pin, gen_salt('bf')) where id = p_operator_id;
$$;

/* -------------------------------------------------- E. the wall cannot name an original
 * Law 7. wall_photos returned storage_path - the full-size original - beside thumb_path.
 * The wall was structurally able to serve 840KB images, which is the v1 egress failure.
 * The column is removed from the return type entirely, so the wall cannot name an
 * original even by mistake.
 */

drop function if exists wall_photos(text, integer);

create function wall_photos(p_event_slug text, p_limit integer default 24)
returns table (
  id uuid,
  kind text,
  thumb_path text,
  created_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select p.id, p.kind, p.thumb_path, p.created_at
    from photos p
    join events e on e.id = p.event_id
   where e.slug = p_event_slug
     and p.approved = true
     and p.status = 'ready'
   order by p.created_at desc
   limit greatest(1, least(coalesce(p_limit, 24), 60));
$$;

comment on function wall_photos(text, integer) is
  'INV-1: the wall gate. approved AND ready, thumbnails only. There is no path from here to an original.';

/* ------------------------------------------- F. a thumbnail is a condition of being ready
 * thumb_path was nullable with nothing enforcing it, so a photo with no thumbnail could
 * be confirmed and approved - and any wall would then have had to fall back to the
 * original. "Thumbnails generated at upload" becomes a check constraint.
 */

alter table photos
  add constraint photos_thumb_required_when_ready
  check (status <> 'ready' or thumb_path is not null);

/* -------------------------------------------- G. a cross-event row cannot be referenced
 * Law 5. Twelve RPCs key on a bare row id and never check the event, so an id belonging
 * to event B was operable while acting for event A. Verifying that in every function body
 * is defensive coding; making the reference impossible is structural.
 *
 * Composite keys carry event_id into every foreign key, so the database itself refuses to
 * join a photo, operator or job across events. Nullable child columns still behave: a
 * MATCH SIMPLE foreign key is satisfied when any of its columns is null.
 */

alter table photos    add constraint photos_id_event_uk    unique (id, event_id);
alter table operators add constraint operators_id_event_uk unique (id, event_id);

alter table photos drop constraint photos_operator_id_fkey;
alter table photos drop constraint photos_source_photo_id_fkey;
alter table photos drop constraint photos_approved_by_fkey;

alter table photos
  add constraint photos_operator_same_event
  foreign key (operator_id, event_id) references operators (id, event_id);
alter table photos
  add constraint photos_source_same_event
  foreign key (source_photo_id, event_id) references photos (id, event_id);
alter table photos
  add constraint photos_approved_by_same_event
  foreign key (approved_by, event_id) references operators (id, event_id);

alter table ai_jobs drop constraint ai_jobs_photo_id_fkey;
alter table ai_jobs drop constraint ai_jobs_operator_id_fkey;
alter table ai_jobs drop constraint ai_jobs_result_photo_id_fkey;

alter table ai_jobs
  add constraint ai_jobs_photo_same_event
  foreign key (photo_id, event_id) references photos (id, event_id);
alter table ai_jobs
  add constraint ai_jobs_operator_same_event
  foreign key (operator_id, event_id) references operators (id, event_id);
alter table ai_jobs
  add constraint ai_jobs_result_same_event
  foreign key (result_photo_id, event_id) references photos (id, event_id);

/* ------------------------------------------------------------- H. the executable backstop
 * Superuser is unavailable, so nothing in the database can *prevent* a future migration
 * from creating an unlocked table or an unpinned security definer function. This function
 * detects it. The phase gate calls it and fails on any row, which under law 13 means every
 * later phase re-runs the check before its report.
 */

create or replace function assert_schema_locked()
returns table (violation text, object_name text, detail text)
language sql stable security definer set search_path = public, pg_catalog, pg_temp
as $$
  -- a table in public without row level security
  select 'rls_disabled', c.relname::text, 'table in public has RLS switched off'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity

  union all
  -- any privilege held by a public-facing role on a table or sequence. The ACL is read
  -- directly: information_schema.role_table_grants only reports roles the caller belongs
  -- to, so it can miss a grant entirely.
  select 'anon_grant', c.relname::text,
         'grants to ' || coalesce(nullif(pg_get_userbyid(a.grantee), ''), 'PUBLIC')
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
  -- a security definer function whose search_path is not pinned. create or replace
  -- replaces a function's configuration wholesale, so 0007's pinning is a snapshot that
  -- a careless later migration can silently undo.
  select 'unpinned_search_path', p.oid::regprocedure::text, 'security definer without a set search_path'
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and (p.proconfig is null
          or not exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search\_path=%'))

  union all
  -- the faucet itself, re-opened
  select 'open_default_privileges', n.nspname::text || ' (' || d.defaclobjtype || ')',
         'default privileges still grant to a public-facing role'
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
   where n.nspname = 'public'
     and pg_get_userbyid(d.defaclrole) = 'postgres'
     and d.defaclacl::text ~ '(anon|authenticated)=';
$$;

comment on function assert_schema_locked() is
  'Returns one row per structural violation. Zero rows is the invariant. The phase gate fails on any row.';

-- Bring every routine created above under the service_role-only rule.
select apply_function_grants();
