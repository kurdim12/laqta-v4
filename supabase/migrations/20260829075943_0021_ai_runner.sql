-- 0021_ai_runner.sql
--
-- Phase 3, the plumbing: everything the AI job runner needs from the database, before the
-- runner itself is deployed.
--
--   LAW 4 SHAPE. The runner is an Edge Function that pg_cron pokes every minute through
--   pg_net. Between pokes it owns its own clock: it claims jobs under the per-event lease from
--   0014, heartbeats while a model takes its ninety seconds, and nothing in this chain imposes
--   a platform timeout on the generation itself.
--
--   THE POKE IS AUTHENTICATED BY SOMETHING ONLY THIS DATABASE KNOWS. The worker must not be
--   publicly triggerable, and no secret may enter the repository. So the token lives in a
--   service-role-only table: pg_cron reads it when poking, and the worker - which holds the
--   service key - reads the same row to verify the poke. Nothing new for the owner to manage.
--
--   ENQUEUE BECOMES IDEMPOTENT. The Phase 0 audit flagged this and Phase 1 made it urgent: an
--   offline outbox that crashed after enqueueing retries the whole capture, and a bare insert
--   would start a SECOND PAID GENERATION of the same photo. A partial unique index makes the
--   retry converge on the existing job, the same way photo registration converges on the
--   existing photo. A photo whose jobs ALL failed may be enqueued again - that is an operator
--   decision, not a retry.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

create extension if not exists pg_net;

/* ------------------------------------------------------------------- the worker's token */

create table worker_tokens (
  name       text primary key,
  token      text not null,
  created_at timestamptz not null default now()
);

alter table worker_tokens enable row level security;

insert into worker_tokens (name, token)
values ('ai-worker', encode(gen_random_bytes(24), 'hex'))
on conflict (name) do nothing;

comment on table worker_tokens is
  'Shared secrets between pg_cron and the workers it pokes. Service-role only; never in the repository, never shown to anyone.';

/* --------------------------------------------------- per-event AI configuration (D, law 5) */

alter table events
  add column ai_reference_paths text[] not null default '{}',
  add column ai_est_cost_usd numeric(8, 4) not null default 0.04
    check (ai_est_cost_usd >= 0);

comment on column events.ai_est_cost_usd is
  'The estimate consume_generation books BEFORE the paid call. settle_generation swaps it for the real cost after.';

create or replace function api_set_event_ai(
  p_slug             text,
  p_ai_prompt        text default null,
  p_ai_model         text default null,
  p_ai_allowed       text[] default null,
  p_budget_usd       numeric default null,
  p_est_cost_usd     numeric default null,
  p_max_generations  integer default null,
  p_reference_paths  text[] default null
)
returns setof events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event events;
begin
  select * into v_event from events where slug = p_slug;
  if not found then
    raise exception 'UNKNOWN_EVENT' using hint = 'No event with that slug.';
  end if;

  -- The model picker picks from the allowed list; a typo cannot silently break every
  -- generation at event time, which is how v1 lost money to configuration.
  if p_ai_model is not null
     and not (p_ai_model = any(coalesce(p_ai_allowed, v_event.ai_allowed_models))) then
    raise exception 'MODEL_NOT_ALLOWED'
      using hint = 'Add the model to the allowed list before selecting it.';
  end if;

  return query
    update events
       set ai_prompt          = coalesce(p_ai_prompt, ai_prompt),
           ai_model           = coalesce(p_ai_model, ai_model),
           ai_allowed_models  = coalesce(p_ai_allowed, ai_allowed_models),
           ai_budget_usd      = coalesce(p_budget_usd, ai_budget_usd),
           ai_est_cost_usd    = coalesce(p_est_cost_usd, ai_est_cost_usd),
           max_generations    = coalesce(p_max_generations, max_generations),
           ai_reference_paths = coalesce(p_reference_paths, ai_reference_paths),
           updated_at         = now()
     where slug = p_slug
    returning *;
end;
$$;

/* ------------------------------------------------------------- idempotent enqueue (laws 1, 4) */

create unique index ai_jobs_photo_active_uk on ai_jobs (photo_id) where status <> 'failed';

create or replace function api_enqueue_job(p_event_id uuid, p_photo_id uuid, p_operator_id uuid)
returns setof ai_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_paused boolean;
begin
  select ai_paused into v_paused from events where id = p_event_id;
  if v_paused is null then
    raise exception 'UNKNOWN_EVENT' using hint = 'No event with that id.';
  end if;
  if v_paused then
    raise exception 'AI_PAUSED'
      using hint = 'Generation is paused for this event from the control room.';
  end if;

  -- A replayed enqueue lands on the partial unique index and converges on the job that
  -- already exists, exactly as a replayed photo upload converges on the photo. Money cannot
  -- be spent twice by a flaky network.
  return query
    insert into ai_jobs (event_id, photo_id, operator_id, status)
    values (p_event_id, p_photo_id, p_operator_id, 'queued')
    on conflict (photo_id) where status <> 'failed' do nothing
    returning *;

  if not found then
    return query
      select * from ai_jobs j
       where j.photo_id = p_photo_id and j.status <> 'failed'
       order by j.created_at desc limit 1;
  end if;
end;
$$;

/* --------------------------------------------------------------- cutouts land on photos (F, 2) */

alter table photos add column cutout_path text;

comment on column photos.cutout_path is
  'A background-removed cutout in the thumbs bucket, produced on the capture device with a hard timeout. Null means the wall uses the thumbnail - the automatic fallback law 2 requires.';

create or replace function api_set_photo_cutout(p_photo_id uuid, p_cutout_path text)
returns setof photos
language sql
security definer
set search_path = public, pg_temp
as $$
  update photos set cutout_path = p_cutout_path where id = p_photo_id returning *;
$$;

/* ------------------------------------- the wall types learn about cutouts (return type change) */

drop function if exists wall_photos(text, integer);

create function wall_photos(p_event_slug text, p_limit integer default 24)
returns table (
  id uuid,
  kind text,
  thumb_path text,
  cutout_path text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.kind, p.thumb_path, p.cutout_path, p.created_at
    from photos p
    join events e on e.id = p.event_id
   where e.slug = p_event_slug
     and p.approved = true
     and p.status = 'ready'
     and e.panic_brand_only = false
     and (e.wall_frozen = false or p.created_at <= coalesce(e.wall_frozen_at, now()))
   order by p.created_at desc
   limit greatest(1, least(coalesce(p_limit, 24), 60));
$$;

comment on function wall_photos(text, integer) is
  'INV-1: the wall gate. approved AND ready, thumbnails and cutouts only, obedient to freeze and panic. There is no path from here to an original.';

drop function if exists wall_lightbox(text);

create function wall_lightbox(p_event_slug text)
returns table (cell_index integer, photo_id uuid, thumb_path text, cutout_path text, kind text)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_event events;
begin
  select * into v_event from events e where e.slug = p_event_slug;
  if not found then
    return;
  end if;

  delete from wall_cells wc
   using photos p
   where wc.event_id = v_event.id
     and p.id = wc.photo_id
     and not (p.approved and p.status = 'ready');

  if v_event.panic_brand_only then
    return;
  end if;

  if not v_event.wall_frozen then
    insert into wall_cells (event_id, cell_index, photo_id)
    select v_event.id, e.i, u.id
      from (select gs.i, row_number() over (order by gs.i) as rn
              from generate_series(0, 27) gs(i)
             where not exists (select 1 from wall_cells wc
                                where wc.event_id = v_event.id and wc.cell_index = gs.i)) e
      join (select p.id, row_number() over (order by p.created_at desc) as rn
              from photos p
             where p.event_id = v_event.id
               and p.approved and p.status = 'ready'
               and not exists (select 1 from wall_cells wc
                                where wc.event_id = v_event.id and wc.photo_id = p.id)) u
        using (rn)
    on conflict do nothing;
  end if;

  return query
    select wc.cell_index, p.id, p.thumb_path, p.cutout_path, p.kind
      from wall_cells wc
      join photos p on p.id = wc.photo_id and p.event_id = wc.event_id
     where wc.event_id = v_event.id
       and p.approved and p.status = 'ready'
     order by wc.cell_index;
end;
$$;

/* ----------------------------------------------------------------- what the worker drains */

create or replace function api_events_with_queued_jobs()
returns table (event_id uuid, queued bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- ai_paused is honoured here as well as at enqueue: pausing AI mid-event stops the worker
  -- touching that event's queue on the next poke, not merely new enqueues.
  select j.event_id, count(*)
    from ai_jobs j
    join events e on e.id = j.event_id
   where j.status = 'queued'
     and e.ai_paused = false
   group by j.event_id
   order by count(*) desc;
$$;

/* --------------------------------------------------------- the minute poke (law 4's clock) */

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable -- skipping ai worker poke';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'poke_ai_worker') then
    perform cron.unschedule('poke_ai_worker');
  end if;
  perform cron.schedule('poke_ai_worker', '* * * * *', $cron$
    select net.http_post(
      url := 'https://bdzdvlnmocojsifdkpvd.supabase.co/functions/v1/ai-worker',
      body := jsonb_build_object('mode', 'drain'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-laqta-worker', (select token from worker_tokens where name = 'ai-worker')
      ),
      timeout_milliseconds := 5000
    );
  $cron$);
end
$$;

select apply_function_grants();

do $$
declare v_count integer;
begin
  select count(*) into v_count from assert_schema_locked();
  if v_count > 0 then
    raise exception 'schema lock assertion failed with % violation(s) after 0021', v_count;
  end if;
end
$$;
