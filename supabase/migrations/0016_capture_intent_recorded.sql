-- 0016_capture_intent_recorded.sql
--
-- 0014 added the capture provenance columns - device, the time the shot was really taken, the
-- capture surface, and the operator's per-shot restyle choice - but nothing wrote to them,
-- because api_upsert_photo_if_absent still had 0003's parameter list. Columns nothing fills
-- are worse than absent columns: they read as a feature in the schema and are empty in the
-- data, which is exactly how v1 ended up unable to say which model produced an image.
--
-- Feature C requires "per-shot choice of AI restyle or straight-through". That intent cannot
-- be inferred later from whether an ai_jobs row happens to exist: a straight-through shot and
-- a restyle whose job was never enqueued because AI was paused look identical afterwards. So
-- it is recorded at capture time, by the person who made the choice.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

drop function if exists api_upsert_photo_if_absent(uuid, uuid, uuid, text, text, text, integer);

create function api_upsert_photo_if_absent(
  p_photo_id           uuid,
  p_event_id           uuid,
  p_operator_id        uuid,
  p_kind               text,
  p_storage_path       text,
  p_thumb_path         text,
  p_bytes              integer,
  p_device_id          text default null,
  p_client_captured_at timestamptz default null,
  p_capture_source     text default 'booth',
  p_restyle_intent     text default 'straight'
)
returns setof photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_paused boolean;
begin
  select intake_paused into v_paused from events where id = p_event_id;
  if v_paused is null then
    raise exception 'UNKNOWN_EVENT' using hint = 'No event with that id.';
  end if;
  if v_paused then
    raise exception 'INTAKE_PAUSED'
      using hint = 'Capture is paused for this event from the control room.';
  end if;

  -- Idempotent by client-minted id: a retried upload from an offline outbox cannot become a
  -- second photo. 'do nothing' rather than 'do update' on purpose - a retry must not be able
  -- to rewrite the provenance of a shot that already landed.
  return query
    insert into photos (id, event_id, operator_id, kind, storage_path, thumb_path, bytes,
                        status, device_id, client_captured_at, capture_source, restyle_intent)
    values (p_photo_id, p_event_id, p_operator_id, p_kind, p_storage_path, p_thumb_path,
            p_bytes, 'processing', p_device_id,
            coalesce(p_client_captured_at, now()),
            coalesce(p_capture_source, 'booth'),
            coalesce(p_restyle_intent, 'straight'))
    on conflict (id) do nothing
    returning *;

  if not found then
    return query select * from photos where id = p_photo_id;
  end if;
end;
$$;

comment on function api_upsert_photo_if_absent(uuid, uuid, uuid, text, text, text, integer, text, timestamptz, text, text) is
  'The capture write. Idempotent on the client-minted id, and records who chose what on this shot rather than leaving it to be guessed later.';

select apply_function_grants();

do $$
declare v_count integer;
begin
  select count(*) into v_count from assert_schema_locked();
  if v_count > 0 then
    raise exception 'schema lock assertion failed with % violation(s) after 0016', v_count;
  end if;
end
$$;
