-- 0014_capture_stations_and_leases.sql
--
-- Law 10 finished, plus the capture and moderation columns Phase 0's data model owes the
-- later phases, plus the lease that stops law 4's sweeper paying for the same image twice.
--
--   LAW 10. sweep_ai_jobs covered ai_jobs and nothing else. A photo whose upload died between
--   being announced and being confirmed sat in 'processing' forever. Every transient state now
--   has a sweeper, every sweeper writes a heartbeat on every pass including the quiet ones, and
--   the TTL is a per-event column rather than a number buried in a function.
--
--   THE DOUBLE-PAY BUG. sweep_ai_jobs re-queued anything 'running' for three minutes. A model
--   that legitimately needs ninety seconds, plus an upload, can cross that line while perfectly
--   healthy - and the requeue would start a SECOND paid generation of the same photo. Jobs now
--   carry a lease that a live worker renews; only an expired lease is reclaimed.
--
--   A LATE SYNC IS NOT A LOST PHOTO. The photo sweeper marks abandoned uploads 'expired'
--   rather than deleting them, and confirming an expired photo brings it back. A device that
--   reconnects twenty minutes after the venue internet died must not find its shots destroyed
--   by our own housekeeping - that would be law 1 defeated by law 10.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

/* ------------------------------------------------------- per-event timings (law 5 again) */

alter table events
  add column upload_ttl_minutes integer not null default 30
    check (upload_ttl_minutes between 1 and 1440),
  add column ai_lease_seconds integer not null default 240
    check (ai_lease_seconds between 30 and 3600),
  add column ai_max_attempts integer not null default 3
    check (ai_max_attempts between 1 and 10),
  add column station_offline_seconds integer not null default 30
    check (station_offline_seconds between 5 and 600);

comment on column events.ai_lease_seconds is
  'How long a worker may hold a job before it is considered dead. Must exceed the slowest model plus its upload.';

/* ------------------------------------------------------- stations and heartbeats (feature G) */

create table stations (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references events (id),
  device_id         text not null,
  kind              text not null
                    check (kind in ('booth', 'kiosk', 'wall', 'control', 'shirt', 'avatar')),
  label             text not null default '',
  app_version       text,
  queue_depth       integer not null default 0 check (queue_depth >= 0),
  last_heartbeat_at timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (event_id, device_id)
);

alter table stations enable row level security;
create index stations_event_idx on stations (event_id, last_heartbeat_at desc);

comment on column stations.queue_depth is
  'How many captures this device is still holding locally. This is the number that tells ops a booth is behind.';

create or replace function api_station_heartbeat(
  p_event_id    uuid,
  p_device_id   text,
  p_kind        text,
  p_label       text default '',
  p_queue_depth integer default 0,
  p_app_version text default null
)
returns setof stations
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into stations (event_id, device_id, kind, label, queue_depth, app_version, last_heartbeat_at)
  values (p_event_id, p_device_id, p_kind, coalesce(p_label, ''),
          greatest(0, coalesce(p_queue_depth, 0)), p_app_version, now())
  on conflict (event_id, device_id) do update
     set kind = excluded.kind,
         label = excluded.label,
         queue_depth = excluded.queue_depth,
         app_version = coalesce(excluded.app_version, stations.app_version),
         last_heartbeat_at = now()
  returning *;
$$;

create or replace function api_stations(p_event_id uuid)
returns table (
  device_id   text,
  kind        text,
  label       text,
  queue_depth integer,
  app_version text,
  seconds_ago integer,
  online      boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.device_id, s.kind, s.label, s.queue_depth, s.app_version,
         extract(epoch from (now() - s.last_heartbeat_at))::integer as seconds_ago,
         (now() - s.last_heartbeat_at) < make_interval(secs => e.station_offline_seconds) as online
    from stations s
    join events e on e.id = s.event_id
   where s.event_id = p_event_id
   order by s.kind, s.device_id;
$$;

/* ------------------------------------------------------ capture provenance (feature C, law 1) */

alter table photos
  add column device_id          text,
  add column client_captured_at timestamptz,
  add column capture_source     text
    check (capture_source is null or
           capture_source in ('booth', 'kiosk', 'shirt', 'avatar', 'import')),
  add column restyle_intent     text
    check (restyle_intent is null or restyle_intent in ('restyle', 'straight')),
  add column use_original       boolean not null default false,
  add column rejected_reason    text,
  add column deleted_at         timestamptz;

comment on column photos.client_captured_at is
  'When the shot was actually taken on the device, which after an outage is not when it arrived.';
comment on column photos.restyle_intent is
  'The operator''s per-shot choice. Inferring it from whether a job row happens to exist cannot tell a straight-through shot from a restyle that was never enqueued.';

create index photos_device_idx on photos (event_id, device_id, created_at desc)
  where device_id is not null;

/* --------------------------------------------------------- the five moderation states (E) */

alter table photos drop constraint photos_status_check;
alter table photos add constraint photos_status_check
  check (status in ('processing', 'ready', 'hidden', 'rejected', 'deleted', 'expired'));

-- The publish gate has to hold for the new states too: only 'ready' may ever be approved.
-- photos_guard_approved already enforces exactly that, so rejected, deleted and expired
-- photos are unapprovable by the same trigger, without it needing to know they exist.

create or replace function api_reject_photo(p_photo_id uuid, p_operator_id uuid, p_reason text default null)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_photo photos;
begin
  select * into v_photo from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;

  perform log_override(v_photo.event_id, p_operator_id, 'reject', 'photo', p_photo_id,
                       jsonb_build_object('status', v_photo.status, 'approved', v_photo.approved),
                       jsonb_build_object('status', 'rejected'), p_reason);

  return query
    update photos
       set status = 'rejected', approved = false, approved_by = null, approved_at = null,
           rejected_reason = p_reason
     where id = p_photo_id
    returning *;
end;
$$;

create or replace function api_delete_photo(p_photo_id uuid, p_operator_id uuid, p_reason text default null)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_photo photos;
begin
  select * into v_photo from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;

  perform log_override(v_photo.event_id, p_operator_id, 'delete', 'photo', p_photo_id,
                       jsonb_build_object('status', v_photo.status, 'approved', v_photo.approved),
                       jsonb_build_object('status', 'deleted'), p_reason);

  -- A soft delete. The row survives so the audit trail still points at something real, and so
  -- the storage object can be reclaimed deliberately rather than orphaned.
  return query
    update photos
       set status = 'deleted', approved = false, approved_by = null, approved_at = null,
           deleted_at = now()
     where id = p_photo_id
    returning *;
end;
$$;

create or replace function api_use_original(p_photo_id uuid, p_operator_id uuid)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_photo photos; v_source uuid;
begin
  select * into v_photo from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;
  if v_photo.source_photo_id is null then
    raise exception 'NO_ORIGINAL' using hint = 'This photo is not a generated derivative of anything.';
  end if;
  v_source := v_photo.source_photo_id;

  perform log_override(v_photo.event_id, p_operator_id, 'use_original', 'photo', p_photo_id,
                       jsonb_build_object('generated', p_photo_id),
                       jsonb_build_object('original', v_source));

  -- The restyle steps aside and the original is published in its place.
  update photos set use_original = true, approved = false, approved_by = null, approved_at = null
   where id = p_photo_id;

  return query
    update photos
       set approved = true, approved_by = p_operator_id, approved_at = now()
     where id = v_source
    returning *;
end;
$$;

/* -------------------------------------------------------- the AI job lease (law 4, and money)
 * claim_ai_job now takes the lease from the event rather than from an argument, so the timeout
 * is a per-event setting like everything else, and a live worker can renew it.
 */

alter table ai_jobs
  add column lease_until timestamptz,
  add column locked_by   text,
  add column started_at  timestamptz;

create index ai_jobs_lease_idx on ai_jobs (status, lease_until);

drop function if exists claim_ai_job(integer, integer);

create function claim_ai_job(p_event_id uuid, p_worker text)
returns setof ai_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease   integer;
  v_max     integer;
begin
  select ai_lease_seconds, ai_max_attempts into v_lease, v_max
    from events where id = p_event_id;
  if v_lease is null then
    raise exception 'UNKNOWN_EVENT' using hint = 'No event with that id.';
  end if;

  return query
    update ai_jobs j
       set status = 'running',
           attempts = j.attempts + 1,
           started_at = now(),
           locked_by = p_worker,
           lease_until = now() + make_interval(secs => v_lease),
           updated_at = now()
     where j.id = (
       select c.id
         from ai_jobs c
        where c.event_id = p_event_id
          and c.status = 'queued'
          and c.attempts < v_max
        order by c.created_at
        for update skip locked
        limit 1
     )
    returning j.*;
end;
$$;

comment on function claim_ai_job(uuid, text) is
  'Bound to one event (law 5) and holding a renewable lease, so a slow but living worker is never overtaken by the sweeper.';

create or replace function api_job_heartbeat(p_job_id uuid, p_worker text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease integer;
  v_ok    boolean;
begin
  select e.ai_lease_seconds into v_lease
    from ai_jobs j join events e on e.id = j.event_id
   where j.id = p_job_id;
  if v_lease is null then
    return false;
  end if;

  update ai_jobs
     set lease_until = now() + make_interval(secs => v_lease),
         updated_at = now()
   where id = p_job_id and locked_by = p_worker and status = 'running'
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

comment on function api_job_heartbeat(uuid, text) is
  'A worker that is still alive renews its lease. This is what makes the requeue safe: only a job nobody is holding is reclaimed.';

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
  -- ONLY an EXPIRED lease is reclaimed. The old version re-queued anything running for three
  -- minutes, which would start a second paid generation of a photo a healthy worker was still
  -- producing.
  with bumped as (
    update ai_jobs
       set status = 'queued', locked_by = null, lease_until = null, updated_at = now()
     where status = 'running'
       and lease_until is not null
       and lease_until < now()
    returning event_id
  )
  select count(*), coalesce(array_agg(event_id), '{}') into v_requeued, v_req from bumped;

  with exhausted as (
    update ai_jobs j
       set status = 'failed',
           error = coalesce(j.error, 'exhausted retries'),
           updated_at = now()
      from events e
     where e.id = j.event_id
       and j.status = 'queued'
       and j.attempts >= e.ai_max_attempts
    returning j.event_id
  )
  select count(*), coalesce(array_agg(event_id), '{}') into v_failed, v_fail from exhausted;

  for r in
    select ev,
           (select count(*) from unnest(v_req)  x where x = ev) as requeued,
           (select count(*) from unnest(v_fail) y where y = ev) as failed
      from (select distinct ev from unnest(v_req || v_fail) as ev) t
  loop
    perform record_op('sweep', 'sweep_ai_jobs', true, null, r.ev,
                      jsonb_build_object('requeued', r.requeued, 'failed', r.failed), 'sweeper');
  end loop;

  insert into sweeper_runs (sweeper, changed, detail)
  values ('sweep_ai_jobs', v_requeued + v_failed,
          jsonb_build_object('requeued', v_requeued, 'failed', v_failed));

  return jsonb_build_object('requeued', v_requeued, 'failed', v_failed);
end;
$$;

/* --------------------------------------------------- the photo sweeper (law 10, gently) */

create or replace function api_confirm_photo(p_photo_id uuid)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- 'expired' is included deliberately. A device that reconnects long after the venue internet
  -- died must be able to complete its upload; housekeeping marking the row abandoned must not
  -- become the reason the photo is lost. Law 10 may not defeat law 1.
  return query
    update photos
       set status = 'ready'
     where id = p_photo_id
       and status in ('processing', 'expired')
    returning *;

  if not found then
    return query select * from photos where id = p_photo_id;
  end if;
end;
$$;

create or replace function sweep_photos()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expired int := 0;
  v_ev      uuid[] := '{}';
  r         record;
begin
  with gone as (
    update photos p
       set status = 'expired'
      from events e
     where e.id = p.event_id
       and p.status = 'processing'
       and p.created_at < now() - make_interval(mins => e.upload_ttl_minutes)
    returning p.event_id
  )
  select count(*), coalesce(array_agg(event_id), '{}') into v_expired, v_ev from gone;

  for r in select distinct ev from unnest(v_ev) as ev loop
    perform record_op('sweep', 'sweep_photos', true, null, r.ev,
                      jsonb_build_object('expired',
                        (select count(*) from unnest(v_ev) x where x = r.ev)), 'sweeper');
  end loop;

  insert into sweeper_runs (sweeper, changed, detail)
  values ('sweep_photos', v_expired, jsonb_build_object('expired', v_expired));

  return jsonb_build_object('expired', v_expired);
end;
$$;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable -- skipping photo sweep schedule';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'sweep_photos') then
    perform cron.unschedule('sweep_photos');
  end if;
  perform cron.schedule('sweep_photos', '* * * * *', $cron$ select sweep_photos(); $cron$);
end
$$;

select apply_function_grants();

do $$
declare v_count integer;
begin
  select count(*) into v_count from assert_schema_locked();
  if v_count > 0 then
    raise exception 'schema lock assertion failed with % violation(s) after 0014', v_count;
  end if;
end
$$;
