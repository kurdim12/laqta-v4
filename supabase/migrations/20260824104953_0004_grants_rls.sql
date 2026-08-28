-- LAQTA v3 migration 0004_grants_rls
-- Applied to Supabase project bdzdvlnmocojsifdkpvd as version 20260824104953
-- Recovered from supabase_migrations.schema_migrations. The SQL below is
-- character-identical to the applied statement, plus one trailing newline.
-- APPLIED MIGRATION - NEVER EDIT. Corrections go in a new numbered migration.

set check_function_bodies = off;

alter table events                  enable row level security;
alter table operators               enable row level security;
alter table operator_login_attempts enable row level security;
alter table photos                  enable row level security;
alter table ai_jobs                 enable row level security;
alter table ops_events              enable row level security;

revoke all on all tables in schema public from anon, authenticated;

create or replace function apply_function_grants()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  anon_allowed text[] := array['wall_photos'];
begin
  for r in
    select p.oid::regprocedure as sig, p.proname as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);

    if r.name = any (anon_allowed) then
      execute format('grant execute on function %s to anon, authenticated', r.sig);
    end if;
  end loop;
end;
$$;

comment on function apply_function_grants() is
  'INV-4: re-run at the end of EVERY migration that adds or replaces a function. Postgres grants EXECUTE to PUBLIC by default.';

select apply_function_grants();

notify pgrst, 'reload schema';
