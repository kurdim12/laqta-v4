-- LAQTA v3 migration 0006_cron
-- Applied to Supabase project bdzdvlnmocojsifdkpvd as version 20260824105009
-- Recovered from supabase_migrations.schema_migrations. The SQL below is
-- character-identical to the applied statement, plus one trailing newline.
-- APPLIED MIGRATION - NEVER EDIT. Corrections go in a new numbered migration.

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable -- skipping sweep schedule';
    return;
  end if;

  create extension if not exists pg_cron;

  if exists (select 1 from cron.job where jobname = 'sweep_ai_jobs') then
    perform cron.unschedule('sweep_ai_jobs');
  end if;

  perform cron.schedule('sweep_ai_jobs', '* * * * *', $cron$ select sweep_ai_jobs(); $cron$);
end
$$;
