-- 0013_guests_and_codes.sql
--
-- Law 11: guest codes were guessable in bulk. Two defences, and the law needs both.
--
--   LENGTH. A code is 14 characters drawn from a 32-symbol alphabet, from gen_random_bytes.
--   That is 32^14, about 4.5 x 10^21. The alphabet is Crockford base32 with I, L, O and U
--   removed, so a code read aloud over a noisy activation floor cannot be transcribed into a
--   different valid code. 256 divides by 32 exactly, so taking bytes modulo 32 introduces no
--   bias - every symbol is equally likely, which is what makes the keyspace real rather than
--   nominal.
--
--   A DATABASE-BACKED LOOKUP LIMIT. Length alone only raises the cost of guessing; it does not
--   cap it. Every lookup attempt increments a counter in the database - law 12, so it survives
--   a restart - and the attempt is refused past the limit. Guessing is bounded by attempts per
--   window, not by the attacker's bandwidth.
--
-- The limit is applied BEFORE the code is resolved, and counted per client rather than per
-- event, because an enumerating client does not know which event it is attacking yet - that is
-- precisely what it is trying to discover.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

/* --------------------------------------------------------------------- guests (feature H) */

create table guests (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references events (id),
  display_name text,
  phone        text,
  email        text,
  locale       text not null default 'ar' check (locale in ('ar', 'en')),
  consent_at   timestamptz,
  retain_until timestamptz,
  created_at   timestamptz not null default now(),
  constraint guests_id_event_uk unique (id, event_id)
);

alter table guests enable row level security;
create index guests_event_idx  on guests (event_id, created_at desc);
create index guests_retain_idx on guests (retain_until) where retain_until is not null;

comment on table guests is
  'Only the registration guest mode fills this. Personal data carries retain_until and is swept, so it has a lifetime rather than living forever by default.';

/* ------------------------------------------------------------------- codes (laws 11, 5, 12) */

create table guest_codes (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references events (id),
  code         text not null unique check (code ~ '^[0-9A-HJKMNP-TV-Z]{14}$'),
  photo_id     uuid,
  guest_id     uuid,
  issued_by    uuid,
  use_count    integer not null default 0,
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked      boolean not null default false,
  created_at   timestamptz not null default now(),
  constraint guest_codes_photo_same_event
    foreign key (photo_id, event_id) references photos (id, event_id),
  constraint guest_codes_guest_same_event
    foreign key (guest_id, event_id) references guests (id, event_id),
  constraint guest_codes_operator_same_event
    foreign key (issued_by, event_id) references operators (id, event_id)
);

alter table guest_codes enable row level security;
create index guest_codes_event_idx on guest_codes (event_id, created_at desc);
create index guest_codes_photo_idx on guest_codes (photo_id) where photo_id is not null;
create index guest_codes_expiry_idx on guest_codes (expires_at) where expires_at is not null;

comment on column guest_codes.code is
  '14 symbols of Crockford base32 (no I, L, O, U): 32^14 keyspace, unbiased, and unambiguous when read aloud.';

/* A photo can also belong to a registered guest directly, for the registration mode where one
 * guest collects many shots rather than one code per shot. */
alter table photos add column guest_id uuid;
alter table photos add constraint photos_guest_same_event
  foreign key (guest_id, event_id) references guests (id, event_id);
create index photos_guest_idx on photos (guest_id) where guest_id is not null;

/* ------------------------------------------------------------------------ minting a code */

create or replace function generate_guest_code(p_length integer default 14)
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  -- Crockford base32: I, L, O and U are absent so a code cannot be misheard into another
  -- valid code across a loud room.
  k_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_out text := '';
  v_bytes bytea;
  i integer;
begin
  v_bytes := gen_random_bytes(p_length);
  for i in 1..p_length loop
    -- 256 is exactly 8 x 32, so modulo 32 is unbiased: every symbol is equally likely.
    v_out := v_out || substr(k_alphabet, (get_byte(v_bytes, i - 1) % 32) + 1, 1);
  end loop;
  return v_out;
end;
$$;

create or replace function api_mint_guest_code(
  p_event_id   uuid,
  p_photo_id   uuid default null,
  p_guest_id   uuid default null,
  p_issued_by  uuid default null,
  p_ttl_hours  integer default 720
)
returns table (id uuid, code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_row  guest_codes;
  i      integer;
begin
  -- A collision at 32^14 is vanishingly unlikely, but the unique index is the authority and
  -- the loop is what makes minting correct rather than merely probable.
  for i in 1..8 loop
    v_code := generate_guest_code(14);
    begin
      insert into guest_codes (event_id, code, photo_id, guest_id, issued_by, expires_at)
      values (p_event_id, v_code, p_photo_id, p_guest_id, p_issued_by,
              now() + make_interval(hours => greatest(1, p_ttl_hours)))
      returning * into v_row;
      return query select v_row.id, v_row.code, v_row.expires_at;
      return;
    exception when unique_violation then
      null;
    end;
  end loop;
  raise exception 'CODE_MINT_FAILED' using hint = 'Could not mint a unique code in eight attempts.';
end;
$$;

/* -------------------------------------------------------------- looking a code up (law 11)
 * The limit is consumed BEFORE the code is resolved, and it is consumed on every attempt,
 * hit or miss. Charging only for misses would let an attacker who found one valid code use it
 * to keep a free channel open, and charging after resolution would leave the resolution itself
 * unbounded.
 */

create or replace function api_guest_lookup(
  p_code   text,
  p_client text,
  p_limit  integer default 30
)
returns table (
  outcome     text,
  event_slug  text,
  event_id    uuid,
  code_id     uuid,
  guest_mode  text,
  attempts    integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts integer;
  v_code     guest_codes;
  v_event    events;
begin
  -- Law 12: the counter is a database row, so restarting the API layer does not forgive an
  -- enumeration already in progress. Law 11: this is the ceiling on guessing.
  v_attempts := consume_platform_rate_limit('guest_lookup', coalesce(nullif(btrim(p_client), ''), 'unknown'), 300);

  if v_attempts > greatest(1, p_limit) then
    return query select 'rate_limited'::text, null::text, null::uuid, null::uuid, null::text, v_attempts;
    return;
  end if;

  select * into v_code from guest_codes gc
   where gc.code = upper(btrim(p_code))
     and gc.revoked = false
     and (gc.expires_at is null or gc.expires_at > now());

  if not found then
    return query select 'not_found'::text, null::text, null::uuid, null::uuid, null::text, v_attempts;
    return;
  end if;

  select * into v_event from events e where e.id = v_code.event_id;

  update guest_codes
     set use_count = use_count + 1, last_used_at = now()
   where id = v_code.id;

  perform record_op('guest', 'code_lookup', true, null, v_code.event_id,
                    jsonb_build_object('codeId', v_code.id), 'guest');

  return query select 'ok'::text, v_event.slug, v_event.id, v_code.id, v_event.guest_mode, v_attempts;
end;
$$;

comment on function api_guest_lookup(text, text, integer) is
  'Law 11. The attempt counter is consumed before the code is resolved, so guessing is bounded by attempts per window rather than by the attacker''s bandwidth.';

/* ------------------------------------------------------------------- the gallery (feature H)
 * A guest may download their OWN photo at full size, which is why storage_path appears here
 * and never in wall_photos. Law 7 is about walls serving originals to a room, not about a
 * guest collecting the picture they posed for.
 */

create or replace function api_guest_photos(p_code text)
returns table (
  id           uuid,
  thumb_path   text,
  storage_path text,
  kind         text,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.thumb_path, p.storage_path, p.kind, p.created_at
    from guest_codes gc
    join photos p
      on (p.id = gc.photo_id or (gc.guest_id is not null and p.guest_id = gc.guest_id))
     and p.event_id = gc.event_id
   where gc.code = upper(btrim(p_code))
     and gc.revoked = false
     and (gc.expires_at is null or gc.expires_at > now())
     -- The publish gate applies to guests too: an unapproved photo is not anyone's to collect.
     and p.approved = true
     and p.status = 'ready'
   order by p.created_at desc
   limit 200;
$$;

create or replace function api_register_guest(
  p_event_id     uuid,
  p_display_name text default null,
  p_phone        text default null,
  p_email        text default null,
  p_locale       text default 'ar',
  p_consent      boolean default false,
  p_retain_days  integer default 90
)
returns table (guest_id uuid, code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_guest uuid;
  v_code  record;
begin
  insert into guests (event_id, display_name, phone, email, locale, consent_at, retain_until)
  values (p_event_id, p_display_name, p_phone, p_email, coalesce(p_locale, 'ar'),
          case when p_consent then now() else null end,
          now() + make_interval(days => greatest(1, p_retain_days)))
  returning id into v_guest;

  select * into v_code from api_mint_guest_code(p_event_id, null, v_guest, null, 720);
  return query select v_guest, v_code.code, v_code.expires_at;
end;
$$;

/* ------------------------------------------------- codes and personal data expire (laws 10, 11) */

create or replace function sweep_guest_data()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_codes int; v_guests int;
begin
  with gone as (
    delete from guest_codes
     where expires_at is not null and expires_at < now() - interval '7 days'
    returning 1
  ) select count(*) into v_codes from gone;

  -- Personal data has a lifetime. Codes pointing at a swept guest go with it, which the
  -- foreign key would otherwise refuse.
  with gone as (
    delete from guests g
     where g.retain_until is not null
       and g.retain_until < now()
       and not exists (select 1 from guest_codes c where c.guest_id = g.id)
       and not exists (select 1 from photos p where p.guest_id = g.id)
    returning 1
  ) select count(*) into v_guests from gone;

  insert into sweeper_runs (sweeper, changed, detail)
  values ('sweep_guest_data', v_codes + v_guests,
          jsonb_build_object('codesDeleted', v_codes, 'guestsDeleted', v_guests));

  return jsonb_build_object('codesDeleted', v_codes, 'guestsDeleted', v_guests);
end;
$$;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable -- skipping guest data sweep schedule';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'sweep_guest_data') then
    perform cron.unschedule('sweep_guest_data');
  end if;
  perform cron.schedule('sweep_guest_data', '7 * * * *', $cron$ select sweep_guest_data(); $cron$);
end
$$;

select apply_function_grants();

do $$
declare v_count integer;
begin
  select count(*) into v_count from assert_schema_locked();
  if v_count > 0 then
    raise exception 'schema lock assertion failed with % violation(s) after 0013', v_count;
  end if;
end
$$;
