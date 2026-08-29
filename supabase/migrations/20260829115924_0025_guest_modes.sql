-- 0025_guest_modes.sql
--
-- Phase 5, the data layer: the three guest modes become enforced shapes, not labels.
--
--   A MODE IS WHAT THE DATABASE PERMITS, NOT WHAT THE UI SHOWS. 0013 built codes, guests and
--   the rate-limited lookup, but any mode could mint anything. Now the mint itself checks the
--   event's mode: a photo-bound code exists only under code_per_shot, a guest-bound code only
--   under registration, and wall_only can mint nothing at all - so a wall-only event cannot
--   leak a gallery no matter what any client sends (law 5: the mode lives on the events row).
--
--   ONE SHOT, ONE CODE. Re-minting for a photo that already has a live code returns that code
--   instead of a second one. The operator's button becomes idempotent the same way the outbox
--   is: a retry converges on what already exists.
--
--   REGISTRATION IS CHARGED LIKE LOOKUP IS. api_register_guest inserts personal data on an
--   unauthenticated path, so it now consumes a database-backed platform limit BEFORE touching
--   the guests table - laws 11 and 12 applied to the write side, not just the read side.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

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
  v_mode text;
  v_code text;
  v_row  guest_codes;
  i      integer;
begin
  select guest_mode into v_mode from events e where e.id = p_event_id;
  if v_mode is null then
    raise exception 'UNKNOWN_EVENT' using hint = 'No event with that id.';
  end if;

  -- The mode decides what a code may be bound to. An unbound code opens nothing and is
  -- refused outright rather than minted as noise.
  if p_photo_id is not null then
    if v_mode <> 'code_per_shot' then
      raise exception 'MODE_REFUSES_PHOTO_CODE'
        using hint = 'Per-shot codes exist only when the event''s guest mode is code_per_shot.';
    end if;
  elsif p_guest_id is not null then
    if v_mode <> 'registration' then
      raise exception 'MODE_REFUSES_GUEST_CODE'
        using hint = 'Guest-bound codes exist only when the event''s guest mode is registration.';
    end if;
  else
    raise exception 'CODE_UNBOUND'
      using hint = 'A code must be bound to a photo or a guest.';
  end if;

  -- One live code per shot: the operator's mint button converges on the existing credential
  -- instead of scattering equivalents.
  if p_photo_id is not null then
    select * into v_row from guest_codes gc
     where gc.photo_id = p_photo_id
       and gc.revoked = false
       and (gc.expires_at is null or gc.expires_at > now())
     order by gc.created_at desc
     limit 1;
    if found then
      return query select v_row.id, v_row.code, v_row.expires_at;
      return;
    end if;
  end if;

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

comment on function api_mint_guest_code(uuid, uuid, uuid, uuid, integer) is
  'Minting obeys the event''s guest mode structurally, and a photo re-mint returns the shot''s existing live code.';

/* ------------------------------------------------------- registration, charged and gated */

drop function if exists api_register_guest(uuid, text, text, text, text, boolean, integer);

create function api_register_guest(
  p_event_id     uuid,
  p_display_name text default null,
  p_phone        text default null,
  p_email        text default null,
  p_locale       text default 'ar',
  p_consent      boolean default false,
  p_retain_days  integer default 90,
  p_client       text default 'unknown',
  p_limit        integer default 10
)
returns table (outcome text, guest_id uuid, code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode     text;
  v_attempts integer;
  v_guest    uuid;
  v_code     record;
begin
  -- Charged BEFORE anything is written or revealed, per client, exactly as the lookup is.
  -- Law 12: the counter is a row, so a restart forgives nothing.
  v_attempts := consume_platform_rate_limit('guest_register',
                  coalesce(nullif(btrim(p_client), ''), 'unknown'), 300);
  if v_attempts > greatest(1, p_limit) then
    return query select 'rate_limited'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  select e.guest_mode into v_mode from events e where e.id = p_event_id;
  if v_mode is null then
    return query select 'not_found'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;
  if v_mode <> 'registration' then
    return query select 'mode_refused'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  insert into guests (event_id, display_name, phone, email, locale, consent_at, retain_until)
  values (p_event_id, p_display_name, p_phone, p_email, coalesce(p_locale, 'ar'),
          case when p_consent then now() else null end,
          now() + make_interval(days => greatest(1, p_retain_days)))
  returning id into v_guest;

  select * into v_code from api_mint_guest_code(p_event_id, null, v_guest, null, 720);
  return query select 'ok'::text, v_guest, v_code.code, v_code.expires_at;
end;
$$;

comment on function api_register_guest(uuid, text, text, text, text, boolean, integer, text, integer) is
  'Feature H registration mode. The platform limit is consumed before the insert, so the unauthenticated write side is bounded the same way the read side is.';

/* ----------------------------------- a registered guest''s shots carry their owner (H, 1) */

drop function if exists api_upsert_photo_if_absent(uuid, uuid, uuid, text, text, text, integer, text, timestamptz, text, text);

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
  p_restyle_intent     text default 'straight',
  p_guest_id           uuid default null
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
  -- to rewrite the provenance of a shot that already landed. The guest binding rides the
  -- same write: a guest registered before an outage keeps collecting shots through it,
  -- because the guest id is on the device, not fetched at send time. The composite foreign
  -- key refuses a guest from another event - the binding is scoped by construction (law 5).
  return query
    insert into photos (id, event_id, operator_id, kind, storage_path, thumb_path, bytes,
                        status, device_id, client_captured_at, capture_source, restyle_intent,
                        guest_id)
    values (p_photo_id, p_event_id, p_operator_id, p_kind, p_storage_path, p_thumb_path,
            p_bytes, 'processing', p_device_id,
            coalesce(p_client_captured_at, now()),
            coalesce(p_capture_source, 'booth'),
            coalesce(p_restyle_intent, 'straight'),
            p_guest_id)
    on conflict (id) do nothing
    returning *;

  if not found then
    return query select * from photos where id = p_photo_id;
  end if;
end;
$$;

comment on function api_upsert_photo_if_absent(uuid, uuid, uuid, text, text, text, integer, text, timestamptz, text, text, uuid) is
  'The capture write. Idempotent on the client-minted id, records who chose what on this shot, and binds a registered guest''s shots to them at capture time.';

/* --------------------------------------------------------------------- the Phase 5 gate */

create or replace function gate_phase_5()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  w uuid; c uuid; r uuid; opC uuid; opR uuid;
  ph uuid; ph2 uuid; phr uuid;
  v_guest uuid; v_code text; v_code2 text; v_out record;
  n integer; t text; ok boolean;
  v_client text := 'gate-h-' || gen_random_uuid();
begin
  perform gate_cleanup();

  insert into events (slug, name, status, guest_mode) values ('gate-h-wall', 'Gate Wall Only', 'live', 'wall_only') returning id into w;
  insert into events (slug, name, status, guest_mode) values ('gate-h-code', 'Gate Code Mode', 'live', 'code_per_shot') returning id into c;
  insert into events (slug, name, status, guest_mode) values ('gate-h-reg',  'Gate Registration', 'live', 'registration') returning id into r;
  select id into opC from api_create_operator(c, 'gatehc', 'Gate H C', 'A', 'operator', '1357');
  select id into opR from api_create_operator(r, 'gatehr', 'Gate H R', 'A', 'operator', '2468');

  /* -------------------------------------------------- wall_only can open no gallery at all */

  area := 'feature H'; check_name := 'a wall-only event refuses to mint any code';
  begin
    perform api_mint_guest_code(w, gen_random_uuid(), null, null, 720);
    t := 'MINTED';
  exception when others then
    t := sqlerrm;
  end;
  expected := 'MODE_REFUSES_PHOTO_CODE'; actual := t; pass := (t = 'MODE_REFUSES_PHOTO_CODE'); return next;

  area := 'feature H'; check_name := 'a wall-only event refuses registration';
  select o.outcome into t from api_register_guest(w, 'x', null, null, 'en', true, 90, v_client, 10) o;
  expected := 'mode_refused'; actual := t; pass := (t = 'mode_refused'); return next;

  area := 'feature H'; check_name := 'an unbound code cannot exist';
  begin
    perform api_mint_guest_code(c, null, null, null, 720);
    t := 'MINTED';
  exception when others then
    t := sqlerrm;
  end;
  expected := 'CODE_UNBOUND'; actual := t; pass := (t = 'CODE_UNBOUND'); return next;

  /* ------------------------------------------------------- code_per_shot: one shot, one code */

  ph := gen_random_uuid();
  perform api_upsert_photo_if_absent(ph, c, opC, 'original', 'o/h1.jpg', 't/h1.jpg', 10,
                                     'gate-h-dev', now(), 'booth', 'straight', null);
  perform api_confirm_photo(ph);
  perform approve_photo(ph, opC);

  select gc.code into v_code from api_mint_guest_code(c, ph, null, opC, 720) gc;

  area := 'law 11'; check_name := 'a minted code is 14 symbols of the unambiguous alphabet';
  expected := 'matches ^[0-9A-HJKMNP-TV-Z]{14}$'; actual := coalesce(v_code, '(null)');
  pass := (v_code ~ '^[0-9A-HJKMNP-TV-Z]{14}$'); return next;

  select gc.code into v_code2 from api_mint_guest_code(c, ph, null, opC, 720) gc;

  area := 'feature H'; check_name := 're-minting a shot returns its existing live code';
  expected := 'same code'; actual := case when v_code2 = v_code then 'same code' else 'A SECOND CODE' end;
  pass := (v_code2 = v_code); return next;

  select * into v_out from api_guest_lookup(v_code, v_client, 30);

  area := 'feature H'; check_name := 'the code resolves to its event and mode';
  expected := 'ok gate-h-code code_per_shot';
  actual := coalesce(v_out.outcome, '?') || ' ' || coalesce(v_out.event_slug, '?') || ' ' || coalesce(v_out.guest_mode, '?');
  pass := (v_out.outcome = 'ok' and v_out.event_slug = 'gate-h-code' and v_out.guest_mode = 'code_per_shot'); return next;

  area := 'feature H'; check_name := 'the gallery behind the code holds exactly the shot';
  select count(*) into n from api_guest_photos(v_code);
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  ph2 := gen_random_uuid();
  perform api_upsert_photo_if_absent(ph2, c, opC, 'original', 'o/h2.jpg', 't/h2.jpg', 10,
                                     'gate-h-dev', now(), 'booth', 'straight', null);
  perform api_confirm_photo(ph2);
  select gc.code into v_code2 from api_mint_guest_code(c, ph2, null, opC, 720) gc;

  area := 'feature E'; check_name := 'an unapproved shot is invisible even to its own code';
  select count(*) into n from api_guest_photos(v_code2);
  expected := '0'; actual := n::text; pass := (n = 0); return next;

  /* ----------------------------------------------------- registration: one guest, many shots */

  select * into v_out from api_register_guest(r, 'Gate Guest', '+96270000000', null, 'ar', true, 90, v_client, 10);
  v_guest := v_out.guest_id; v_code := v_out.code;

  area := 'feature H'; check_name := 'registration returns a working code';
  expected := 'ok, code present';
  actual := coalesce(v_out.outcome, '?') || case when v_code is null then ', no code' else ', code present' end;
  pass := (v_out.outcome = 'ok' and v_code is not null); return next;

  area := 'feature H'; check_name := 'consent and retention are recorded, not implied';
  select (g.consent_at is not null and g.retain_until is not null) into ok from guests g where g.id = v_guest;
  expected := 'true'; actual := coalesce(ok::text, '(none)'); pass := (ok is true); return next;

  phr := gen_random_uuid();
  perform api_upsert_photo_if_absent(phr, r, opR, 'original', 'o/h3.jpg', 't/h3.jpg', 10,
                                     'gate-h-dev', now(), 'kiosk', 'straight', v_guest);
  perform api_confirm_photo(phr);
  perform approve_photo(phr, opR);

  area := 'feature H'; check_name := 'a shot bound at capture reaches the guest''s gallery';
  select count(*) into n from api_guest_photos(v_code);
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  area := 'law 5'; check_name := 'a guest from one event cannot be bound to another''s photo';
  begin
    perform api_upsert_photo_if_absent(gen_random_uuid(), c, opC, 'original', 'o/h4.jpg', 't/h4.jpg', 10,
                                       'gate-h-dev', now(), 'kiosk', 'straight', v_guest);
    t := 'BOUND';
  exception when others then
    t := 'refused';
  end;
  expected := 'refused'; actual := t; pass := (t = 'refused'); return next;

  area := 'law 5'; check_name := 'three modes ran side by side and no event''s config moved';
  select count(*) into n from events e
   where (e.id = w and e.guest_mode <> 'wall_only')
      or (e.id = c and e.guest_mode <> 'code_per_shot')
      or (e.id = r and e.guest_mode <> 'registration');
  expected := '0'; actual := n::text; pass := (n = 0); return next;

  /* --------------------------------------------- the write side is charged like the read side */

  for n in 1..10 loop
    perform api_register_guest(r, null, null, null, 'ar', false, 90, v_client || '-w', 10);
  end loop;
  select o.outcome into t from api_register_guest(r, null, null, null, 'ar', false, 90, v_client || '-w', 10) o;

  area := 'law 11'; check_name := 'registration past the limit is refused before anything is written';
  expected := 'rate_limited'; actual := t; pass := (t = 'rate_limited'); return next;

  perform gate_cleanup();
  return;
end;
$$;

create or replace function run_all_gates()
returns table (phase text, area text, check_name text, expected text, actual text, pass boolean)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select 'phase 0'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from run_phase_0_gate() g
  union all
  select 'phase 0'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_0_capture() g
  union all
  select 'phase 1'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_1() g
  union all
  select 'phase 2'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_2() g
  union all
  select 'phase 3'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_3() g
  union all
  select 'phase 4'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_4() g
  union all
  select 'phase 5'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_5() g;
$$;

select apply_function_grants();

do $$
declare v_fails integer;
begin
  select count(*) into v_fails from run_all_gates() where not pass;
  if v_fails > 0 then
    raise exception 'gate suite red after 0025: % failing check(s)', v_fails;
  end if;
end
$$;