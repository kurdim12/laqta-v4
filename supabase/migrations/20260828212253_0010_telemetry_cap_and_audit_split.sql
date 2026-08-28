-- 0010_telemetry_cap_and_audit_split.sql
--
-- Law 3. v1 wrote 561,000 junk error rows in a week because record_op was an unconditional
-- INSERT. This migration makes that arithmetically impossible, and resolves the conflict
-- between law 3 and feature E: overrides were being logged into the very table law 3
-- requires capping, so capping it would have deleted the audit trail.
--
-- Two rules the owner added, both structural here rather than advisory:
--
--   1. A CAP DROPS DETAIL, NEVER SIGNAL. Going over the cap stops itemising new kinds of
--      error; it never stops saying that the device is failing. A reserved marker row keeps
--      counting, and ops_quota.dropped keeps the exact number that went un-itemised. A
--      capped device can never be mistaken for a quiet one.
--
--   2. TELEMETRY FAILURE CAN NEVER BLOCK THE PHOTO PATH. record_op ends in an exception
--      handler, which in plpgsql is a subtransaction: anything that goes wrong inside is
--      rolled back to the savepoint and the caller's transaction survives. Recording that a
--      photo arrived can never be the reason the photo does not.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

/* ------------------------------------------------------- per-event telemetry policy (law 5) */

alter table events
  add column telemetry_cap_per_device_hour integer not null default 50
    check (telemetry_cap_per_device_hour between 1 and 10000),
  add column telemetry_retention_days integer not null default 14
    check (telemetry_retention_days between 1 and 365);

comment on column events.telemetry_cap_per_device_hour is
  'Distinct error kinds one device may itemise per hour. Beyond it, detail is dropped and counted.';

/* --------------------------------------------------------------------- the audit trail (E)
 * Append-only and never trimmed. This is the half of the old ops_events that must survive
 * forever, so it lives in its own table with its own rules. Nothing in this schema deletes
 * from it, and no sweeper touches it.
 */

create table audit_log (
  id                bigint generated always as identity primary key,
  event_id          uuid not null references events (id),
  actor_kind        text not null check (actor_kind in ('operator', 'admin', 'system')),
  actor_operator_id uuid,
  actor_label       text not null,
  action            text not null,
  target_kind       text not null,
  target_id         uuid,
  before            jsonb,
  after             jsonb,
  reason            text,
  created_at        timestamptz not null default now(),
  constraint audit_actor_same_event
    foreign key (actor_operator_id, event_id) references operators (id, event_id)
);

alter table audit_log enable row level security;
create index audit_log_event_idx  on audit_log (event_id, created_at desc);
create index audit_log_target_idx on audit_log (target_kind, target_id, created_at desc);

comment on table audit_log is
  'Every override, forever. Append-only: no sweeper and no retention policy touches this table.';

/* ------------------------------------------------------------- the sweeper heartbeat (law 10)
 * Law 10 requires sweeps to be VISIBLE. The old sweeper only logged when it changed
 * something, so a healthy sweeper and a dead one looked identical. This table gets a row on
 * every pass, including the quiet ones. It is system-level rather than event-scoped on
 * purpose: sweeper liveness is infrastructure health, not a per-event setting, and law 5 is
 * about event settings and counters not bleeding across events.
 */

create table sweeper_runs (
  id       bigint generated always as identity primary key,
  sweeper  text not null,
  ran_at   timestamptz not null default now(),
  changed  integer not null default 0,
  detail   jsonb not null default '{}'
);

alter table sweeper_runs enable row level security;
create index sweeper_runs_recent_idx on sweeper_runs (sweeper, ran_at desc);

/* ---------------------------------------------------------------- the durable cap (laws 3,12)
 * The counter lives in the database, so it survives a restart - which is law 12 - and it is
 * keyed by event, so one event's noisy tablet cannot spend another event's allowance, which
 * is law 5.
 */

create table ops_quota (
  event_id     uuid not null references events (id),
  device_id    text not null,
  window_start timestamptz not null,
  rows_used    integer not null default 0,
  dropped      integer not null default 0,
  primary key (event_id, device_id, window_start)
);

alter table ops_quota enable row level security;

comment on column ops_quota.dropped is
  'Distinct error kinds refused after the cap. This is the number that keeps the signal honest.';

/* --------------------------------------------------------------- telemetry becomes collapsible
 * event_id becomes NOT NULL (law 5: no global bucket bleeding into every event's ops view).
 * The unique key is what makes flooding impossible: a repeat cannot become a new row.
 */

alter table ops_events add column device_id    text not null default 'server';
alter table ops_events add column fingerprint  text not null default '';
alter table ops_events add column window_start timestamptz not null default date_trunc('hour', now());
alter table ops_events add column n            integer not null default 1 check (n > 0);
alter table ops_events add column last_seen_at timestamptz not null default now();

alter table ops_events alter column event_id set not null;
alter table ops_events add constraint ops_events_event_fk foreign key (event_id) references events (id);

alter table ops_events
  add constraint ops_events_dedupe_uk unique (event_id, device_id, fingerprint, window_start);

create index ops_events_retention_idx on ops_events (event_id, created_at);

comment on column ops_events.n is
  'Occurrences collapsed into this row. Five thousand identical errors are one row with n = 5000.';

/* ------------------------------------------------------------------------ record_op, rewritten
 * The signature gains a device, so the cap can be per-device. The old six-argument form is
 * dropped first: keeping it would make every existing six-argument call ambiguous against the
 * new seven-argument-with-default one.
 */

drop function if exists record_op(text, text, boolean, integer, uuid, jsonb);

create function record_op(
  p_service   text,
  p_event     text,
  p_ok        boolean,
  p_ms        integer default null,
  p_event_id  uuid    default null,
  p_meta      jsonb   default '{}',
  p_device_id text    default 'server'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window  timestamptz := date_trunc('hour', now());
  v_device  text := coalesce(nullif(btrim(p_device_id), ''), 'server');
  v_meta    jsonb := coalesce(p_meta, '{}'::jsonb);
  v_fp      text;
  v_cap     integer;
  v_used    integer;
  v_touched integer;
begin
  if p_event_id is null then
    -- Law 5: telemetry is event-scoped. An unscoped call must still leave a trace rather
    -- than vanish, so it lands on the heartbeat where it can be found and fixed.
    insert into sweeper_runs (sweeper, changed, detail)
    values ('record_op_unscoped', 0,
            jsonb_build_object('service', p_service, 'event', p_event, 'ok', p_ok));
    return;
  end if;

  -- A client cannot flood by payload size either: oversized meta is replaced by its shape.
  if pg_column_size(v_meta) > 2048 then
    v_meta := jsonb_build_object('truncated', true,
                                 'bytes', pg_column_size(p_meta),
                                 'code', v_meta->>'code');
  end if;

  v_fp := md5(p_service || '|' || p_event || '|' || p_ok::text || '|' ||
              coalesce(v_meta->>'code', '') || '|' ||
              left(coalesce(v_meta->>'error', ''), 160));

  -- 1. An identical event in the same hour collapses into the row that already exists. No
  --    allowance is spent, so a client repeating one error forever adds exactly zero rows.
  update ops_events
     set n = n + 1,
         last_seen_at = now(),
         ms = coalesce(p_ms, ms)
   where event_id = p_event_id
     and device_id = v_device
     and fingerprint = v_fp
     and window_start = v_window;
  get diagnostics v_touched = row_count;
  if v_touched > 0 then
    return;
  end if;

  -- 2. A genuinely new kind of error costs one slot from this device's hourly allowance.
  select e.telemetry_cap_per_device_hour into v_cap from events e where e.id = p_event_id;
  v_cap := coalesce(v_cap, 50);

  insert into ops_quota (event_id, device_id, window_start, rows_used)
  values (p_event_id, v_device, v_window, 1)
  on conflict (event_id, device_id, window_start)
    do update set rows_used = ops_quota.rows_used + 1
  returning rows_used into v_used;

  if v_used > v_cap then
    -- 3. THE CAP DROPS DETAIL, NEVER SIGNAL. The new kind is not itemised, but it is
    --    counted in ops_quota.dropped, and the reserved 'capped' marker row keeps rising so
    --    ops can see the device is still in trouble. Worst case per device per hour is
    --    cap + 1 rows, which is what makes the flood arithmetically impossible.
    update ops_quota
       set dropped = dropped + 1
     where event_id = p_event_id and device_id = v_device and window_start = v_window;

    insert into ops_events (service, event, ok, ms, event_id, meta,
                            device_id, fingerprint, window_start, n, last_seen_at)
    values ('telemetry', 'capped', false, null, p_event_id,
            jsonb_build_object('cap', v_cap, 'device', v_device),
            v_device, 'capped', v_window, 1, now())
    on conflict (event_id, device_id, fingerprint, window_start)
      do update set n = ops_events.n + 1, last_seen_at = now();
    return;
  end if;

  insert into ops_events (service, event, ok, ms, event_id, meta,
                          device_id, fingerprint, window_start)
  values (p_service, p_event, p_ok, p_ms, p_event_id, v_meta,
          v_device, v_fp, v_window)
  on conflict (event_id, device_id, fingerprint, window_start)
    do update set n = ops_events.n + 1, last_seen_at = now();

exception when others then
  -- TELEMETRY FAILURE CAN NEVER BLOCK THE PHOTO PATH. This handler is a subtransaction:
  -- whatever went wrong above is rolled back to the savepoint and the caller continues
  -- untouched. The failure is itself recorded where possible, and swallowed where not.
  begin
    insert into sweeper_runs (sweeper, changed, detail)
    values ('record_op_failure', 0,
            jsonb_build_object('sqlstate', sqlstate, 'message', sqlerrm,
                               'service', p_service, 'event', p_event));
  exception when others then
    null;
  end;
end;
$$;

comment on function record_op(text, text, boolean, integer, uuid, jsonb, text) is
  'Law 3. Repeats collapse into a counter; new kinds cost an hourly per-device slot; over the cap the detail is dropped but the signal is not. Never raises to its caller.';

/* ------------------------------------------------------------- audited overrides (feature E) */

create or replace function log_override(
  p_event_id    uuid,
  p_operator_id uuid,
  p_action      text,
  p_target_kind text,
  p_target_id   uuid,
  p_before      jsonb default null,
  p_after       jsonb default null,
  p_reason      text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_label text;
  v_kind  text := 'system';
begin
  if p_operator_id is not null then
    select o.username || ' (' || o.role || ')' into v_label
      from operators o where o.id = p_operator_id;
    v_kind := 'operator';
  end if;

  insert into audit_log (event_id, actor_kind, actor_operator_id, actor_label,
                         action, target_kind, target_id, before, after, reason)
  values (p_event_id, v_kind, p_operator_id, coalesce(v_label, 'system'),
          p_action, p_target_kind, p_target_id, p_before, p_after, p_reason);
end;
$$;

comment on function log_override(uuid, uuid, text, text, uuid, jsonb, jsonb, text) is
  'Writes to audit_log. Deliberately NOT exception-safe: losing an override record is not acceptable, so a failure here fails the override.';

create or replace function approve_photo(p_photo_id uuid, p_operator_id uuid)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_photo photos;
begin
  select * into v_photo from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;

  if v_photo.status <> 'ready' then
    raise exception 'PHOTO_NOT_READY'
      using hint = 'A photo can only be approved once its upload is confirmed (status = ready).';
  end if;

  if v_photo.kind = 'generated'
     and not exists (
       select 1 from ai_jobs j
        where j.result_photo_id = v_photo.id
          and j.status = 'done'
     ) then
    raise exception 'GENERATION_NOT_DONE'
      using hint = 'Wait for the generation to finish before approving the result.';
  end if;

  perform log_override(v_photo.event_id, p_operator_id, 'approve', 'photo', p_photo_id,
                       jsonb_build_object('approved', v_photo.approved),
                       jsonb_build_object('approved', true, 'kind', v_photo.kind));

  return query
    update photos
       set approved = true,
           approved_by = p_operator_id,
           approved_at = now()
     where id = p_photo_id
    returning *;
end;
$$;

create or replace function unapprove_photo(p_photo_id uuid, p_operator_id uuid)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_photo photos;
begin
  select * into v_photo from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;

  perform log_override(v_photo.event_id, p_operator_id, 'unapprove', 'photo', p_photo_id,
                       jsonb_build_object('approved', v_photo.approved,
                                          'approvedBy', v_photo.approved_by),
                       jsonb_build_object('approved', false));

  return query
    update photos
       set approved = false,
           approved_by = null,
           approved_at = null
     where id = p_photo_id
    returning *;
end;
$$;

create or replace function api_hide_photo(p_photo_id uuid, p_operator_id uuid)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_photo photos;
begin
  select * into v_photo from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;

  perform log_override(v_photo.event_id, p_operator_id, 'hide', 'photo', p_photo_id,
                       jsonb_build_object('status', v_photo.status, 'approved', v_photo.approved),
                       jsonb_build_object('status', 'hidden', 'approved', false));

  return query
    update photos
       set status = 'hidden', approved = false, approved_by = null, approved_at = null
     where id = p_photo_id
    returning *;
end;
$$;

create or replace function api_unhide_photo(p_photo_id uuid, p_operator_id uuid)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_photo photos;
begin
  select * into v_photo from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;

  perform log_override(v_photo.event_id, p_operator_id, 'unhide', 'photo', p_photo_id,
                       jsonb_build_object('status', v_photo.status),
                       jsonb_build_object('status', 'ready'));

  update photos set status = 'ready' where id = p_photo_id and status = 'hidden';

  return query select * from photos where id = p_photo_id;
end;
$$;

/* ----------------------------------------------------------- sweepers, now visible (law 10) */

create or replace function sweep_ai_jobs()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requeued int := 0;
  v_failed   int := 0;
  v_req      uuid[] := '{}';
  v_fail     uuid[] := '{}';
  r          record;
begin
  with bumped as (
    update ai_jobs
       set status = 'queued', updated_at = now()
     where status = 'running'
       and updated_at < now() - interval '3 minutes'
    returning event_id
  )
  select count(*), coalesce(array_agg(event_id), '{}') into v_requeued, v_req from bumped;

  with exhausted as (
    update ai_jobs
       set status = 'failed',
           error = coalesce(error, 'exhausted retries'),
           updated_at = now()
     where status = 'queued'
       and attempts >= 3
    returning event_id
  )
  select count(*), coalesce(array_agg(event_id), '{}') into v_failed, v_fail from exhausted;

  -- Law 5: attribute the sweep to the events it actually changed, counted from the rows the
  -- two statements above really touched, rather than one global row that every event's ops
  -- view then folds into its own numbers.
  for r in
    select ev,
           (select count(*) from unnest(v_req)  x where x = ev) as requeued,
           (select count(*) from unnest(v_fail) y where y = ev) as failed
      from (select distinct ev from unnest(v_req || v_fail) as ev) t
  loop
    perform record_op('sweep', 'sweep_ai_jobs', true, null, r.ev,
                      jsonb_build_object('requeued', r.requeued, 'failed', r.failed),
                      'sweeper');
  end loop;

  -- Law 10: the heartbeat is written on EVERY pass, including the quiet ones, so a healthy
  -- sweeper and a dead sweeper no longer look the same in ops.
  insert into sweeper_runs (sweeper, changed, detail)
  values ('sweep_ai_jobs', v_requeued + v_failed,
          jsonb_build_object('requeued', v_requeued, 'failed', v_failed));

  return jsonb_build_object('requeued', v_requeued, 'failed', v_failed);
end;
$$;

create or replace function sweep_ops_events()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_events int;
  v_quota  int;
begin
  with gone as (
    delete from ops_events oe
     using events e
     where e.id = oe.event_id
       and oe.created_at < now() - make_interval(days => e.telemetry_retention_days)
    returning 1
  )
  select count(*) into v_events from gone;

  with gone as (
    delete from ops_quota q
     using events e
     where e.id = q.event_id
       and q.window_start < now() - make_interval(days => e.telemetry_retention_days)
    returning 1
  )
  select count(*) into v_quota from gone;

  insert into sweeper_runs (sweeper, changed, detail)
  values ('sweep_ops_events', v_events + v_quota,
          jsonb_build_object('opsEventsDeleted', v_events, 'quotaRowsDeleted', v_quota));

  return jsonb_build_object('opsEventsDeleted', v_events, 'quotaRowsDeleted', v_quota);
end;
$$;

comment on function sweep_ops_events() is
  'Retention for telemetry only. audit_log is deliberately absent from this function and from every other sweeper.';

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable -- skipping telemetry retention schedule';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'sweep_ops_events') then
    perform cron.unschedule('sweep_ops_events');
  end if;
  perform cron.schedule('sweep_ops_events', '*/10 * * * *', $cron$ select sweep_ops_events(); $cron$);
end
$$;

/* ------------------------------------------------------- ops tells the truth (laws 5, 3, 10) */

create or replace function api_ops_summary(p_event_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_event events;
  v_result jsonb;
begin
  select * into v_event from events where slug = p_event_slug;
  if not found then
    raise exception 'UNKNOWN_EVENT' using hint = 'No event with that slug.';
  end if;

  select jsonb_build_object(
    'event', to_jsonb(v_event),
    'remainingBudget', greatest(0, v_event.max_generations - v_event.generations_used),
    -- Law 5: this event only. The old version also counted rows with a null event_id, which
    -- meant one global failure appeared in every event's dashboard at once.
    'failuresLastHour', (
      select coalesce(sum(n), 0) from ops_events
       where ok = false
         and created_at > now() - interval '1 hour'
         and event_id = v_event.id
    ),
    -- Law 3, made honest: what the cap dropped is reported, never hidden.
    'telemetry', (
      select jsonb_build_object(
        'rowsThisHour', coalesce(sum(q.rows_used), 0),
        'droppedThisHour', coalesce(sum(q.dropped), 0),
        'capPerDeviceHour', v_event.telemetry_cap_per_device_hour,
        'cappedDevices', coalesce(count(*) filter (where q.dropped > 0), 0)
      )
      from ops_quota q
      where q.event_id = v_event.id
        and q.window_start = date_trunc('hour', now())
    ),
    -- Law 10: sweeps are visible, including quiet passes.
    'sweepers', (
      select coalesce(jsonb_agg(s), '[]'::jsonb)
        from (
          select distinct on (sweeper) sweeper, ran_at, changed
            from sweeper_runs
           order by sweeper, ran_at desc
        ) s
    ),
    'jobsByStatus', (
      select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
        from (select status, count(*) as n from ai_jobs
               where event_id = v_event.id group by status) s
    ),
    'photosByBooth', (
      select coalesce(jsonb_agg(b), '[]'::jsonb)
        from (
          select coalesce(o.booth, 'unattributed') as booth,
                 count(*) as photos,
                 count(*) filter (where p.approved) as approved
            from photos p
            left join operators o on o.id = p.operator_id
           where p.event_id = v_event.id
           group by 1
           order by 1
        ) b
    ),
    'recentOps', (
      select coalesce(jsonb_agg(r order by r.last_seen_at desc), '[]'::jsonb)
        from (
          select * from ops_events
           where event_id = v_event.id
           order by last_seen_at desc
           limit 20
        ) r
    ),
    'recentOverrides', (
      select coalesce(jsonb_agg(a order by a.created_at desc), '[]'::jsonb)
        from (
          select actor_label, action, target_kind, target_id, created_at
            from audit_log
           where event_id = v_event.id
           order by created_at desc
           limit 20
        ) a
    )
  ) into v_result;

  return v_result;
end;
$$;

select apply_function_grants();

-- Applying this migration is itself the proof that the schema is still locked.
do $$
declare v_count integer;
begin
  select count(*) into v_count from assert_schema_locked();
  if v_count > 0 then
    raise exception 'schema lock assertion failed with % violation(s) after 0010', v_count;
  end if;
end
$$;
