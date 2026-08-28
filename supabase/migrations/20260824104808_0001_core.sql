-- LAQTA v3 migration 0001_core
-- Applied to Supabase project bdzdvlnmocojsifdkpvd as version 20260824104808
-- Recovered from supabase_migrations.schema_migrations. The SQL below is
-- character-identical to the applied statement, plus one trailing newline.
-- APPLIED MIGRATION - NEVER EDIT. Corrections go in a new numbered migration.

-- 0001_core.sql — tables, constraints, indexes.
-- Append-only. Never edit a migration that has been applied; add a new one.

create extension if not exists pgcrypto;

-- Supabase ships these roles. A bare Postgres (test harness, CI) does not, and the grants in
-- 0003 are meaningless without them, so create them only when absent.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

/* ------------------------------------------------------------------ events */

create table if not exists events (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  name              text not null,
  status            text not null default 'draft'
                    check (status in ('draft', 'live', 'ended')),
  wall_config       jsonb not null default '{}',   -- layout only; anything queried becomes a column
  ai_prompt         text not null default '',
  ai_model          text not null default 'google/gemini-3.1-flash-image',
  max_generations   integer not null default 1000 check (max_generations >= 0),
  generations_used  integer not null default 0 check (generations_used >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

/* --------------------------------------------------------------- operators */

create table if not exists operators (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references events (id),
  username      text not null,
  display_name  text not null,
  booth         text not null,                      -- 'A' | 'B' | free label
  role          text not null default 'operator'
                check (role in ('operator', 'admin')),
  pin_hash      text not null,                      -- bcrypt (pgcrypto crypt/gen_salt('bf'))
  active        boolean not null default true,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (event_id, username)
);

-- Lockout is per-USERNAME, never per-IP: both booths share one venue NAT (v2 lesson).
create table if not exists operator_login_attempts (
  event_id      uuid not null,
  username      text not null,
  window_start  timestamptz not null,
  fails         integer not null default 1,
  primary key (event_id, username, window_start)
);

/* ------------------------------------------------------------------ photos */

create table if not exists photos (
  id              uuid primary key,                  -- CLIENT-minted (INV-7)
  event_id        uuid not null references events (id),
  operator_id     uuid references operators (id),    -- null only for system writes
  kind            text not null
                  check (kind in ('original', 'generated', 'external')),
  source_photo_id uuid references photos (id),       -- generated -> its original
  storage_path    text not null,
  thumb_path      text,
  bytes           integer,
  status          text not null default 'processing'
                  check (status in ('processing', 'ready', 'hidden')),
  approved        boolean not null default false,
  approved_by     uuid references operators (id),
  approved_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists photos_event_status_idx on photos (event_id, status);
create index if not exists photos_wall_idx on photos (event_id, created_at desc)
  where approved = true and status = 'ready';
create index if not exists photos_source_idx on photos (source_photo_id)
  where source_photo_id is not null;

/* ----------------------------------------------------------------- ai_jobs */

create table if not exists ai_jobs (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null references events (id),
  photo_id         uuid not null references photos (id),   -- the source
  operator_id      uuid not null references operators (id),
  status           text not null default 'queued'
                   check (status in ('queued', 'running', 'done', 'failed')),
  attempts         integer not null default 0,
  result_photo_id  uuid references photos (id),
  model            text,                    -- ACTUALLY USED, written by the worker
  latency_ms       integer,
  cost_usd         numeric(8, 4),
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists ai_jobs_claim_idx on ai_jobs (status, updated_at);
create index if not exists ai_jobs_photo_idx on ai_jobs (photo_id, created_at desc);
create index if not exists ai_jobs_result_idx on ai_jobs (result_photo_id)
  where result_photo_id is not null;
-- model + latency persisted because v2 could not tell which model produced an image.

/* -------------------------------------------------------------- ops_events */

create table if not exists ops_events (
  id          bigint generated always as identity primary key,
  service     text not null,
  event       text not null,
  ok          boolean not null,
  ms          integer,
  event_id    uuid,
  meta        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create index if not exists ops_events_recent_idx on ops_events (event_id, created_at desc);
create index if not exists ops_events_failures_idx on ops_events (created_at desc) where ok = false;
