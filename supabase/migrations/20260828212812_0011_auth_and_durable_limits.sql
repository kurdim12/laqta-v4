-- 0011_auth_and_durable_limits.sql
--
-- Laws 6 and 12, and the two defects the adversarial pass found in the login path.
--
--   THE LOCKOUT WAS A CHECK-THEN-ACT RACE. verify_operator read `sum(fails)` with a plain
--   SELECT and then decided. Under READ COMMITTED a burst of concurrent attempts all read the
--   same pre-threshold number and all proceeded to test a PIN. The counter is now the gate
--   itself: one atomic upsert increments and RETURNS the new total, and the caller acts on the
--   returned value. There is no window between reading and deciding because there is no read.
--
--   THE LOCKOUT COULD NOT BE LIFTED. The only statement that cleared attempts ran on
--   successful login, which is exactly what a locked-out operator cannot do. A tablet stuck
--   retrying a wrong PIN therefore held a booth operator out for as long as it kept retrying,
--   mid-event, with no override. There is now an admin unlock and a queryable lock state.
--
-- Also completes feature B: a platform-level admin login, which could not exist while every
-- operator row was pinned to exactly one event.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

/* ------------------------------------------------------------------ platform administrators
 * Deliberately NOT event-scoped, and this is not a law 5 exception. Law 5 forbids global
 * FLAGS, SETTINGS and COUNTERS, because those bleed one event's configuration into another.
 * An administrator is a person, not a setting: feature E requires that an admin "sees all and
 * overrides anything", which an event-pinned row cannot express. Their actions are still
 * recorded per event, in audit_log.
 */

create table admins (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique check (username ~ '^[a-z0-9._-]{3,40}$'),
  display_name  text not null,
  password_hash text not null,
  active        boolean not null default true,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);

alter table admins enable row level security;

comment on table admins is
  'Platform administrators. password_hash is bcrypt and is never returned by any function.';

/* ------------------------------------------------------------- platform-scoped rate counters
 * Event-scoped limits live in rate_limits below. Admin login is not event-scoped, so it gets
 * its own table rather than being allowed to put a null in an event_id column - which is the
 * hole law 5 closed in ops_events.
 */

create table platform_rate_limits (
  scope        text not null,
  subject      text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (scope, subject, window_start)
);

alter table platform_rate_limits enable row level security;

/* ---------------------------------------------------------- event-scoped rate counters (12)
 * One general counter for every limited path: guest code lookups (law 11), uploads, sends.
 * In the database, so it survives a restart, and carrying event_id, so one event cannot spend
 * another's allowance.
 */

create table rate_limits (
  event_id     uuid not null references events (id),
  scope        text not null,
  subject      text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (event_id, scope, subject, window_start)
);

alter table rate_limits enable row level security;
create index rate_limits_sweep_idx on rate_limits (window_start);

comment on table rate_limits is
  'Law 12: every limit is a database row, never a number in a process that forgets on restart.';

/* --------------------------------------------------------------------- the tumbling window
 * A single row per window, rather than per-minute rows summed at read time. That is what
 * makes the counter atomic: the increment and the total are the same operation, so there is
 * nothing to race.
 */

create or replace function limit_window(p_at timestamptz, p_seconds integer)
returns timestamptz
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  -- extract() yields numeric; to_timestamp takes double precision. The cast is explicit so
  -- resolution cannot depend on an implicit numeric conversion being available.
  select to_timestamp((floor(extract(epoch from p_at) / greatest(1, p_seconds))
                       * greatest(1, p_seconds))::double precision);
$$;

create or replace function consume_rate_limit(
  p_event_id uuid,
  p_scope    text,
  p_subject  text,
  p_seconds  integer default 60
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  insert into rate_limits (event_id, scope, subject, window_start, count)
  values (p_event_id, p_scope, left(p_subject, 200), limit_window(now(), p_seconds), 1)
  on conflict (event_id, scope, subject, window_start)
    do update set count = rate_limits.count + 1
  returning count into v_count;
  return v_count;
end;
$$;

comment on function consume_rate_limit(uuid, text, text, integer) is
  'Increments first and returns the new total. Callers act on the RETURNED value - never read then decide.';

create or replace function consume_platform_rate_limit(
  p_scope   text,
  p_subject text,
  p_seconds integer default 300
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  insert into platform_rate_limits (scope, subject, window_start, count)
  values (p_scope, left(p_subject, 200), limit_window(now(), p_seconds), 1)
  on conflict (scope, subject, window_start)
    do update set count = platform_rate_limits.count + 1
  returning count into v_count;
  return v_count;
end;
$$;

/* ------------------------------------------------------------- the operator login, race-free
 * operator_login_attempts keeps its shape; what changes is that window_start is now a single
 * five-minute tumbling bucket instead of per-minute rows that had to be summed. The atomic
 * upsert below both increments and reports the total.
 */

drop function if exists bump_login_failure(uuid, text);

create or replace function consume_login_attempt(p_event_id uuid, p_username text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fails integer;
begin
  insert into operator_login_attempts (event_id, username, window_start, fails)
  values (p_event_id, p_username, limit_window(now(), 300), 1)
  on conflict (event_id, username, window_start)
    do update set fails = operator_login_attempts.fails + 1
  returning fails into v_fails;
  return v_fails;
end;
$$;

drop function if exists verify_operator(text, text, text);

create function verify_operator(
  p_event_slug text,
  p_username   text,
  p_pin        text,
  p_device_id  text default 'unknown'
)
returns table (
  outcome      text,
  operator_id  uuid,
  event_id     uuid,
  username     text,
  display_name text,
  booth        text,
  role         text,
  retry_after  timestamptz
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event    events;
  v_op       operators;
  v_attempts integer;
  v_limit    constant integer := 8;
  v_window   timestamptz := limit_window(now(), 300);
begin
  select * into v_event from events e where e.slug = p_event_slug;
  if not found then
    return query select 'unknown_event'::text, null::uuid, null::uuid, null::text,
                        null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  -- THE COUNTER IS THE GATE. This increments and reports in one statement, so concurrent
  -- attempts each receive a distinct number and everything past the limit is refused. There
  -- is no read-then-decide window for a burst to slip through.
  v_attempts := consume_login_attempt(v_event.id, p_username);

  if v_attempts > v_limit then
    perform record_op('auth', 'locked_out', false, null, v_event.id,
                      jsonb_build_object('username', p_username, 'attempts', v_attempts),
                      p_device_id);
    return query select 'locked_out'::text, null::uuid, v_event.id, p_username,
                        null::text, null::text, null::text,
                        (v_window + interval '300 seconds');
    return;
  end if;

  select * into v_op
    from operators o
   where o.event_id = v_event.id
     and o.username = p_username
     and o.active = true;

  if found and v_op.pin_hash = crypt(p_pin, v_op.pin_hash) then
    -- Success clears the window, so an operator who mistypes twice and then succeeds starts
    -- clean rather than carrying failures toward a lockout.
    delete from operator_login_attempts a
     where a.event_id = v_event.id and a.username = p_username;

    update operators set last_seen_at = now() where id = v_op.id;

    return query select 'ok'::text, v_op.id, v_event.id, v_op.username,
                        v_op.display_name, v_op.booth, v_op.role, null::timestamptz;
    return;
  end if;

  perform record_op('auth', 'login_failed', false, null, v_event.id,
                    jsonb_build_object('username', p_username, 'attempts', v_attempts),
                    p_device_id);

  return query select 'bad_credentials'::text, null::uuid, v_event.id, p_username,
                      null::text, null::text, null::text, null::timestamptz;
end;
$$;

comment on function verify_operator(text, text, text, text) is
  'Returns an outcome rather than raising: raising would roll back the attempt counter and defeat the lockout.';

/* --------------------------------------------------------------- seeing and lifting a lockout
 * The operational half of the fix. A booth going dark mid-event because a tablet is stuck
 * retrying is not an acceptable failure mode, and until now there was no way out of it except
 * waiting for the window to pass with the tablet switched off.
 */

create or replace function api_operator_lock_state(p_event_id uuid, p_username text)
returns table (locked boolean, attempts integer, retry_after timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(a.fails, 0) > 8                       as locked,
         coalesce(a.fails, 0)                           as attempts,
         case when coalesce(a.fails, 0) > 8
              then a.window_start + interval '300 seconds'
              else null end                             as retry_after
    from (select 1) one
    left join operator_login_attempts a
      on a.event_id = p_event_id
     and a.username = p_username
     and a.window_start = limit_window(now(), 300);
$$;

create or replace function api_unlock_operator(
  p_event_id uuid,
  p_username text,
  p_admin_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cleared integer;
  v_label   text := 'system';
begin
  with gone as (
    delete from operator_login_attempts a
     where a.event_id = p_event_id and a.username = p_username
    returning 1
  )
  select count(*) into v_cleared from gone;

  if p_admin_id is not null then
    select ad.username || ' (admin)' into v_label from admins ad where ad.id = p_admin_id;
  end if;

  insert into audit_log (event_id, actor_kind, actor_operator_id, actor_label,
                         action, target_kind, target_id, before, after, reason)
  values (p_event_id,
          case when p_admin_id is null then 'system' else 'admin' end,
          null, coalesce(v_label, 'system'),
          'unlock_operator', 'operator', null,
          jsonb_build_object('username', p_username, 'windowsCleared', v_cleared),
          jsonb_build_object('locked', false),
          'lockout lifted');

  return v_cleared;
end;
$$;

comment on function api_unlock_operator(uuid, text, uuid) is
  'Lifts a lockout mid-event. Always audited: an unlock is an override like any other.';

/* ------------------------------------------------------------------- the administrator login
 * Same pattern as the operator login, same atomic counter, same refusal to hand back the
 * credential. The hash is never in any return type.
 */

create or replace function api_create_admin(
  p_username text, p_display_name text, p_password text
)
returns table (id uuid, username text, display_name text, active boolean, created_at timestamptz)
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  insert into admins (username, display_name, password_hash)
  values (p_username, p_display_name, crypt(p_password, gen_salt('bf')))
  returning admins.id, admins.username, admins.display_name, admins.active, admins.created_at;
$$;

create or replace function api_set_admin_password(p_admin_id uuid, p_password text)
returns void
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  update admins set password_hash = crypt(p_password, gen_salt('bf')) where id = p_admin_id;
$$;

create or replace function verify_admin(p_username text, p_password text)
returns table (
  outcome      text,
  admin_id     uuid,
  username     text,
  display_name text,
  retry_after  timestamptz
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_admin    admins;
  v_attempts integer;
  v_limit    constant integer := 8;
  v_window   timestamptz := limit_window(now(), 300);
begin
  v_attempts := consume_platform_rate_limit('admin_login', p_username, 300);

  if v_attempts > v_limit then
    return query select 'locked_out'::text, null::uuid, p_username, null::text,
                        (v_window + interval '300 seconds');
    return;
  end if;

  select * into v_admin from admins a where a.username = p_username and a.active = true;

  if found and v_admin.password_hash = crypt(p_password, v_admin.password_hash) then
    delete from platform_rate_limits p
     where p.scope = 'admin_login' and p.subject = p_username;

    update admins set last_seen_at = now() where id = v_admin.id;

    return query select 'ok'::text, v_admin.id, v_admin.username, v_admin.display_name,
                        null::timestamptz;
    return;
  end if;

  return query select 'bad_credentials'::text, null::uuid, p_username, null::text,
                      null::timestamptz;
end;
$$;

/* ------------------------------------------------------------------ limits get swept too (10) */

create or replace function sweep_rate_limits()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event int; v_platform int; v_login int;
begin
  with gone as (
    delete from rate_limits where window_start < now() - interval '24 hours' returning 1
  ) select count(*) into v_event from gone;

  with gone as (
    delete from platform_rate_limits where window_start < now() - interval '24 hours' returning 1
  ) select count(*) into v_platform from gone;

  with gone as (
    delete from operator_login_attempts where window_start < now() - interval '24 hours' returning 1
  ) select count(*) into v_login from gone;

  insert into sweeper_runs (sweeper, changed, detail)
  values ('sweep_rate_limits', v_event + v_platform + v_login,
          jsonb_build_object('rateLimits', v_event, 'platform', v_platform, 'login', v_login));

  return jsonb_build_object('rateLimits', v_event, 'platform', v_platform, 'login', v_login);
end;
$$;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable -- skipping rate limit sweep schedule';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'sweep_rate_limits') then
    perform cron.unschedule('sweep_rate_limits');
  end if;
  perform cron.schedule('sweep_rate_limits', '*/15 * * * *', $cron$ select sweep_rate_limits(); $cron$);
end
$$;

select apply_function_grants();

do $$
declare v_count integer;
begin
  select count(*) into v_count from assert_schema_locked();
  if v_count > 0 then
    raise exception 'schema lock assertion failed with % violation(s) after 0011', v_count;
  end if;
end
$$;
