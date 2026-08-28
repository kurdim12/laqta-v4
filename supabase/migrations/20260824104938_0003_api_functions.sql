-- LAQTA v3 migration 0003_api_functions
-- Applied to Supabase project bdzdvlnmocojsifdkpvd as version 20260824104938
-- Recovered from supabase_migrations.schema_migrations. The SQL below is
-- character-identical to the applied statement, plus one trailing newline.
-- APPLIED MIGRATION - NEVER EDIT. Corrections go in a new numbered migration.

set check_function_bodies = off;

create or replace function api_ping()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select true $$;

create or replace function api_event_by_slug(p_slug text)
returns setof events language sql stable security definer set search_path = public, pg_temp
as $$ select * from events where slug = p_slug $$;

create or replace function api_event_by_id(p_event_id uuid)
returns setof events language sql stable security definer set search_path = public, pg_temp
as $$ select * from events where id = p_event_id $$;

create or replace function api_list_events()
returns setof events language sql stable security definer set search_path = public, pg_temp
as $$ select * from events order by created_at desc limit 200 $$;

create or replace function api_operator_by_id(p_operator_id uuid)
returns setof operators language sql stable security definer set search_path = public, pg_temp
as $$ select * from operators where id = p_operator_id $$;

create or replace function api_list_operators(p_event_id uuid)
returns setof operators language sql stable security definer set search_path = public, pg_temp
as $$ select * from operators where event_id = p_event_id order by booth, username $$;

create or replace function api_photo(p_photo_id uuid)
returns setof photos language sql stable security definer set search_path = public, pg_temp
as $$ select * from photos where id = p_photo_id $$;

create or replace function api_latest_job(p_photo_id uuid)
returns setof ai_jobs language sql stable security definer set search_path = public, pg_temp
as $$
  select * from ai_jobs
   where photo_id = p_photo_id or result_photo_id = p_photo_id
   order by created_at desc
   limit 1
$$;

create or replace function api_touch_operator(p_operator_id uuid)
returns void language sql security definer set search_path = public, pg_temp
as $$ update operators set last_seen_at = now() where id = p_operator_id $$;

create or replace function api_upsert_photo_if_absent(
  p_photo_id uuid,
  p_event_id uuid,
  p_operator_id uuid,
  p_kind text,
  p_storage_path text,
  p_thumb_path text,
  p_bytes integer
)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into photos (id, event_id, operator_id, kind, storage_path, thumb_path, bytes, status)
  values (p_photo_id, p_event_id, p_operator_id, p_kind, p_storage_path, p_thumb_path, p_bytes,
          'processing')
  on conflict (id) do nothing;

  return query select * from photos where id = p_photo_id;
end;
$$;

create or replace function api_confirm_photo(p_photo_id uuid)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update photos set status = 'ready'
   where id = p_photo_id and status = 'processing';

  return query select * from photos where id = p_photo_id;
end;
$$;

create or replace function api_hide_photo(p_photo_id uuid, p_operator_id uuid)
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
       set status = 'hidden', approved = false, approved_by = null, approved_at = null
     where id = p_photo_id
    returning *;

  perform record_op('api', 'hide', true, null, v_event_id,
                    jsonb_build_object('photoId', p_photo_id, 'operatorId', p_operator_id));
end;
$$;

create or replace function api_unhide_photo(p_photo_id uuid, p_operator_id uuid)
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

  update photos set status = 'ready' where id = p_photo_id and status = 'hidden';

  perform record_op('api', 'unhide', true, null, v_event_id,
                    jsonb_build_object('photoId', p_photo_id, 'operatorId', p_operator_id));

  return query select * from photos where id = p_photo_id;
end;
$$;

create or replace function api_insert_generated_photo(
  p_photo_id uuid,
  p_event_id uuid,
  p_operator_id uuid,
  p_source_photo_id uuid,
  p_storage_path text,
  p_thumb_path text,
  p_bytes integer
)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into photos (id, event_id, operator_id, kind, source_photo_id, storage_path,
                      thumb_path, bytes, status, approved)
  values (p_photo_id, p_event_id, p_operator_id, 'generated', p_source_photo_id, p_storage_path,
          p_thumb_path, p_bytes, 'ready', false)
  on conflict (id) do nothing;

  return query select * from photos where id = p_photo_id;
end;
$$;

create or replace function api_enqueue_job(p_event_id uuid, p_photo_id uuid, p_operator_id uuid)
returns setof ai_jobs
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into ai_jobs (event_id, photo_id, operator_id, status)
  values (p_event_id, p_photo_id, p_operator_id, 'queued')
  returning *;
$$;

create or replace function api_job_succeeded(
  p_job_id uuid,
  p_result_photo_id uuid,
  p_model text,
  p_latency_ms integer,
  p_cost_usd numeric
)
returns setof ai_jobs
language sql
security definer
set search_path = public, pg_temp
as $$
  update ai_jobs
     set status = 'done',
         result_photo_id = p_result_photo_id,
         model = p_model,
         latency_ms = p_latency_ms,
         cost_usd = p_cost_usd,
         error = null,
         updated_at = now()
   where id = p_job_id
  returning *;
$$;

create or replace function api_job_failed(p_job_id uuid, p_error text, p_model text default null)
returns setof ai_jobs
language sql
security definer
set search_path = public, pg_temp
as $$
  update ai_jobs
     set status = 'failed',
         error = left(coalesce(p_error, 'unknown failure'), 500),
         model = coalesce(p_model, model),
         updated_at = now()
   where id = p_job_id
  returning *;
$$;

create or replace function api_job_requeue(p_job_id uuid, p_error text)
returns setof ai_jobs
language sql
security definer
set search_path = public, pg_temp
as $$
  update ai_jobs
     set status = 'queued',
         error = left(coalesce(p_error, 'retrying'), 500),
         updated_at = now()
   where id = p_job_id
  returning *;
$$;

create or replace function api_booth_feed(
  p_event_id uuid,
  p_operator_id uuid default null,
  p_limit int default 200
)
returns table (
  id uuid,
  event_id uuid,
  operator_id uuid,
  kind text,
  source_photo_id uuid,
  storage_path text,
  thumb_path text,
  bytes integer,
  status text,
  approved boolean,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz,
  operator_booth text,
  job_id uuid,
  job_status text,
  job_attempts integer,
  job_error text,
  job_latency_ms integer,
  job_created_at timestamptz,
  job_updated_at timestamptz,
  job_result_photo_id uuid,
  job_model text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id, p.event_id, p.operator_id, p.kind, p.source_photo_id, p.storage_path, p.thumb_path,
    p.bytes, p.status, p.approved, p.approved_by, p.approved_at, p.created_at,
    o.booth as operator_booth,
    j.id as job_id, j.status as job_status, j.attempts as job_attempts, j.error as job_error,
    j.latency_ms as job_latency_ms, j.created_at as job_created_at, j.updated_at as job_updated_at,
    j.result_photo_id as job_result_photo_id, j.model as job_model
  from photos p
  left join operators o on o.id = p.operator_id
  left join lateral (
    select * from ai_jobs aj
     where aj.photo_id = p.id or aj.result_photo_id = p.id
     order by aj.created_at desc
     limit 1
  ) j on true
  where p.event_id = p_event_id
    and (p_operator_id is null or p.operator_id = p_operator_id)
  order by p.created_at desc
  limit greatest(1, least(coalesce(p_limit, 200), 200));
$$;

create or replace function api_create_event(p_slug text, p_name text)
returns setof events
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into events (slug, name) values (p_slug, p_name) returning *;
$$;

create or replace function api_update_event(
  p_slug text,
  p_name text default null,
  p_ai_prompt text default null,
  p_ai_model text default null,
  p_max_generations integer default null,
  p_status text default null,
  p_wall_config jsonb default null
)
returns setof events
language sql
security definer
set search_path = public, pg_temp
as $$
  update events
     set name = coalesce(p_name, name),
         ai_prompt = coalesce(p_ai_prompt, ai_prompt),
         ai_model = coalesce(p_ai_model, ai_model),
         max_generations = coalesce(p_max_generations, max_generations),
         status = coalesce(p_status, status),
         wall_config = coalesce(p_wall_config, wall_config),
         updated_at = now()
   where slug = p_slug
  returning *;
$$;

create or replace function api_create_operator(
  p_event_id uuid,
  p_username text,
  p_display_name text,
  p_booth text,
  p_role text,
  p_pin text
)
returns setof operators
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into operators (event_id, username, display_name, booth, role, pin_hash)
  values (p_event_id, p_username, p_display_name, p_booth, p_role,
          crypt(p_pin, gen_salt('bf')))
  returning *;
$$;

create or replace function api_set_operator_pin(p_operator_id uuid, p_pin text)
returns setof operators
language sql
security definer
set search_path = public, pg_temp
as $$
  update operators set pin_hash = crypt(p_pin, gen_salt('bf')) where id = p_operator_id
  returning *;
$$;

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
    'failuresLastHour', (
      select count(*) from ops_events
       where ok = false
         and created_at > now() - interval '1 hour'
         and (event_id = v_event.id or event_id is null)
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
      select coalesce(jsonb_agg(r order by r.created_at desc), '[]'::jsonb)
        from (
          select * from ops_events
           where event_id = v_event.id or event_id is null
           order by created_at desc
           limit 20
        ) r
    )
  ) into v_result;

  return v_result;
end;
$$;
