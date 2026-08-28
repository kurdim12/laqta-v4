-- LAQTA v3 migration 0005_storage
-- Applied to Supabase project bdzdvlnmocojsifdkpvd as version 20260824105000
-- Recovered from supabase_migrations.schema_migrations. The SQL below is
-- character-identical to the applied statement, plus one trailing newline.
-- APPLIED MIGRATION - NEVER EDIT. Corrections go in a new numbered migration.

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema absent (bare Postgres) -- skipping bucket creation';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values
    ('photos', 'photos', false, 15728640, array['image/jpeg', 'image/webp', 'image/png']),
    ('thumbs', 'thumbs', false, 15728640, array['image/jpeg', 'image/webp', 'image/png'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
end
$$;
