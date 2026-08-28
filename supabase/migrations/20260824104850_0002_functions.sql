-- LAQTA v3 migration 0002_functions
-- Applied to Supabase project bdzdvlnmocojsifdkpvd as version 20260824104850
-- Recovered from supabase_migrations.schema_migrations. The SQL below is
-- character-identical to the applied statement, plus one trailing newline.
-- APPLIED MIGRATION - NEVER EDIT. Corrections go in a new numbered migration.

set check_function_bodies = off;

create or replace function wall_photos(p_event_slug text, p_limit int default 24)
returns table (
  id uuid,
  kind text,
  storage_path text,
  thumb_path text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.kind, p.storage_path, p.thumb_path, p.created_at
    from photos p
    join events e on e.id = p.event_id
   where e.slug = p_event_slug
     and p.approved = true
     and p.status = 'ready'
   order by p.created_at desc
   limit greatest(1, least(coalesce(p_limit, 24), 60));
$$;

comment on function wall_photos(text, int) is
  'INV-1: the wall gate. approved AND ready, nothing else, nowhere else.';

create or replace function record_op(
  p_service text,
  p_event text,
  p_ok boolean,
  p_ms integer default null,
  p_event_id uuid default null,
  p_meta jsonb default '{}'
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into ops_events (service, event, ok, ms, event_id, meta)
  values (p_service, p_event, p_ok, p_ms, p_event_id, coalesce(p_meta, '{}'::jsonb));
$$;

create or replace function photo_is_wall_eligible(p_photo photos)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_photo.status = 'ready'
     and (
       p_photo.kind <> 'generated'
       or exists (
         select 1 from ai_jobs j
          where j.result_photo_id = p_photo.id
            and j.status = 'done'
       )
     );
$$;

create or replace function photos_guard_approved()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.approved then
    if new.status <> 'ready' then
      raise exception 'PHOTO_NOT_READY'
        using hint = 'A photo can only be approved once its upload is confirmed (status = ready).';
    end if;
    if new.kind = 'generated'
       and not exists (
         select 1 from ai_jobs j
          where j.result_photo_id = new.id
            and j.status = 'done'
       ) then
      raise exception 'GENERATION_NOT_DONE'
        using hint = 'This generated photo has no completed generation job behind it.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists photos_guard_approved on photos;
create trigger photos_guard_approved
  before insert or update on photos
  for each row
  execute function photos_guard_approved();

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

  return query
    update photos
       set approved = true,
           approved_by = p_operator_id,
           approved_at = now()
     where id = p_photo_id
    returning *;

  perform record_op('api', 'approve', true, null, v_photo.event_id,
                    jsonb_build_object('photoId', p_photo_id, 'operatorId', p_operator_id,
                                       'kind', v_photo.kind));
end;
$$;

create or replace function unapprove_photo(p_photo_id uuid, p_operator_id uuid)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
begin
  select event_id into v_event_id from photos where id = p_photo_id;
  if not found then
    raise exception 'UNKNOWN_PHOTO' using hint = 'No photo with that id.';
  end if;

  return query
    update photos
       set approved = false,
           approved_by = null,
           approved_at = null
     where id = p_photo_id
    returning *;

  perform record_op('api', 'unapprove', true, null, v_event_id,
                    jsonb_build_object('photoId', p_photo_id, 'operatorId', p_operator_id));
end;
$$;

create or replace function consume_generation(p_event_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ok boolean;
begin
  update events
     set generations_used = generations_used + 1,
         updated_at = now()
   where id = p_event_id
     and generations_used < max_generations
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

comment on function consume_generation(uuid) is
  'INV-4: one atomic statement is the whole budget. EXECUTE is revoked from anon in 0003.';

create or replace function claim_ai_job(
  p_max_attempts int default 3,
  p_retry_after_seconds int default 0
)
returns setof ai_jobs
language sql
security definer
set search_path = public, pg_temp
as $$
  update ai_jobs j
     set status = 'running',
         attempts = j.attempts + 1,
         updated_at = now()
   where j.id = (
     select c.id
       from ai_jobs c
      where c.status = 'queued'
        and c.attempts < p_max_attempts
        and (
          c.attempts = 0
          or c.updated_at <= now() - make_interval(secs => greatest(0, p_retry_after_seconds))
        )
      order by c.created_at
      for update skip locked
      limit 1
   )
  returning j.*;
$$;

create or replace function sweep_ai_jobs()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requeued int;
  v_failed int;
begin
  with bumped as (
    update ai_jobs
       set status = 'queued',
           updated_at = now()
     where status = 'running'
       and updated_at < now() - interval '3 minutes'
    returning 1
  )
  select count(*) into v_requeued from bumped;

  with exhausted as (
    update ai_jobs
       set status = 'failed',
           error = coalesce(error, 'exhausted retries'),
           updated_at = now()
     where status = 'queued'
       and attempts >= 3
    returning 1
  )
  select count(*) into v_failed from exhausted;

  if v_requeued > 0 or v_failed > 0 then
    perform record_op('sweep', 'sweep_ai_jobs', true, null, null,
                      jsonb_build_object('requeued', v_requeued, 'failed', v_failed));
  end if;

  return jsonb_build_object('requeued', v_requeued, 'failed', v_failed);
end;
$$;

create or replace function bump_login_failure(p_event_id uuid, p_username text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total integer;
begin
  insert into operator_login_attempts (event_id, username, window_start, fails)
  values (p_event_id, p_username, date_trunc('minute', now()), 1)
  on conflict (event_id, username, window_start)
  do update set fails = operator_login_attempts.fails + 1;

  select coalesce(sum(a.fails), 0) into v_total
    from operator_login_attempts a
   where a.event_id = p_event_id
     and a.username = p_username
     and a.window_start > now() - interval '5 minutes';

  return v_total;
end;
$$;

create or replace function verify_operator(p_event_slug text, p_username text, p_pin text)
returns table (
  outcome text,
  operator_id uuid,
  event_id uuid,
  username text,
  display_name text,
  booth text,
  role text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event events;
  v_op operators;
  v_fails int;
begin
  select * into v_event from events e where e.slug = p_event_slug;
  if not found then
    return query select 'unknown_event'::text, null::uuid, null::uuid, null::text,
                        null::text, null::text, null::text;
    return;
  end if;

  select coalesce(sum(a.fails), 0) into v_fails
    from operator_login_attempts a
   where a.event_id = v_event.id
     and a.username = p_username
     and a.window_start > now() - interval '5 minutes';

  if v_fails >= 8 then
    return query select 'locked_out'::text, null::uuid, v_event.id, p_username,
                        null::text, null::text, null::text;
    return;
  end if;

  select * into v_op
    from operators o
   where o.event_id = v_event.id
     and o.username = p_username
     and o.active = true;

  if found and v_op.pin_hash = crypt(p_pin, v_op.pin_hash) then
    delete from operator_login_attempts a
     where a.event_id = v_event.id and a.username = p_username;

    update operators set last_seen_at = now() where id = v_op.id;

    return query select 'ok'::text, v_op.id, v_event.id, v_op.username,
                        v_op.display_name, v_op.booth, v_op.role;
    return;
  end if;

  v_fails := bump_login_failure(v_event.id, p_username);

  perform record_op('api', 'login_failed', false, null, v_event.id,
                    jsonb_build_object('username', p_username, 'fails', v_fails));

  if v_fails >= 8 then
    return query select 'locked_out'::text, null::uuid, v_event.id, p_username,
                        null::text, null::text, null::text;
  else
    return query select 'bad_credentials'::text, null::uuid, v_event.id, p_username,
                        null::text, null::text, null::text;
  end if;
end;
$$;

comment on function verify_operator(text, text, text) is
  'Returns an outcome rather than raising: raising would roll back the attempt counter and defeat the lockout.';
