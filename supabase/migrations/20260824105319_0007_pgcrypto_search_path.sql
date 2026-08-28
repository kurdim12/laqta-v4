-- LAQTA v3 migration 0007_pgcrypto_search_path
-- Applied to Supabase project bdzdvlnmocojsifdkpvd as version 20260824105319
-- Recovered from supabase_migrations.schema_migrations. The SQL below is
-- character-identical to the applied statement, plus one trailing newline.
-- APPLIED MIGRATION - NEVER EDIT. Corrections go in a new numbered migration.

set check_function_bodies = off;

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
set search_path = public, extensions, pg_temp
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
set search_path = public, extensions, pg_temp
as $$
  update operators set pin_hash = crypt(p_pin, gen_salt('bf')) where id = p_operator_id
  returning *;
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
set search_path = public, extensions, pg_temp
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
  'Returns an outcome rather than raising: raising would roll back the attempt counter and defeat the lockout. search_path includes extensions because Supabase keeps pgcrypto there.';

select apply_function_grants();

notify pgrst, 'reload schema';
