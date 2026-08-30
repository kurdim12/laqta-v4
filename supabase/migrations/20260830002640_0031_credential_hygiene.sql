-- 0031_credential_hygiene.sql
--
-- Law 6 says: "No credential is ever stored or displayed readable." Two of its three halves
-- were true. The third was not, and the gate could not see it.
--
--   A CONSTANT CREDENTIAL WAS PUBLISHED IN THE SCHEMA. 0029 gave seed_demo_event a parameter
--   default of '2468' so the rehearsal could be re-seeded in one call. That literal is in the
--   migration file, in a public repository, and readable from pg_proc.proargdefaults by anyone
--   who can read the schema - and it was the live PIN on two live events. The two law-6 gate
--   checks passed throughout, because they asked "is it stored as a bcrypt hash" and "does any
--   function RETURN a credential". Neither asked whether one is READABLE. So the seed now mints
--   a random PIN when none is given, and hands it back exactly once, at creation.
--
--   THERE WAS NO WAY TO CHANGE A CREDENTIAL. api_set_operator_pin and api_set_admin_password
--   have existed since 0008 and 0011 and were reachable from nothing: no API action, no UI. A
--   PIN that leaked at 21:00 worked for the rest of the event, permanently, and an operator
--   could never be retired. A law that cannot be repaired after a breach is not a law, it is a
--   hope. Both are now audited, and 0031's companion API deploy exposes them to the console.
--
--   THE WORK FACTOR WAS pgcrypto's DEFAULT. Every live hash is $2a$06$ - cost 6, roughly
--   sixteen times cheaper to attack than the modern floor. Every mint site moves to cost 10.
--   Existing hashes keep verifying: bcrypt carries its cost in the hash, so old and new coexist
--   and each verifies against its own.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

/* ------------------------------------------------------- an admin actor in the audit trail */

-- log_override records an operator or the system. An admin acting on a credential is neither,
-- and audit_log has always allowed actor_kind = 'admin' - nothing could write it. A separate
-- name rather than a ninth parameter: adding one with a default would make every existing
-- eight-argument call ambiguous, and those calls are the moderation path.
create or replace function log_override_admin(
  p_event_id    uuid,
  p_admin_id    uuid,
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
declare v_label text;
begin
  select a.username || ' (admin)' into v_label from admins a where a.id = p_admin_id;

  insert into audit_log (event_id, actor_kind, actor_operator_id, actor_label,
                         action, target_kind, target_id, before, after, reason)
  values (p_event_id, 'admin', null, coalesce(v_label, 'admin'),
          p_action, p_target_kind, p_target_id, p_before, p_after, p_reason);
end;
$$;

comment on function log_override_admin(uuid, uuid, text, text, uuid, jsonb, jsonb, text) is
  'The admin half of the override trail. Like log_override, deliberately NOT exception-safe: losing the record of a credential change is not acceptable.';

/* --------------------------------------------------------------- every mint site, cost 10 */

create or replace function api_create_operator(
  p_event_id uuid,
  p_username text,
  p_display_name text,
  p_booth text,
  p_role text,
  p_pin text
)
returns table (id uuid, event_id uuid, username text, display_name text, booth text,
               role text, active boolean, last_seen_at timestamptz, created_at timestamptz)
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  insert into operators (event_id, username, display_name, booth, role, pin_hash)
  values (p_event_id, p_username, p_display_name, p_booth, p_role,
          crypt(p_pin, gen_salt('bf', 10)))
  -- The pin-free column list from 0008 is preserved deliberately: law 6 says no function
  -- returns a credential, and `returning *` here would put pin_hash back in the type.
  returning operators.id, operators.event_id, operators.username, operators.display_name,
            operators.booth, operators.role, operators.active, operators.last_seen_at,
            operators.created_at;
$$;

create or replace function api_create_admin(
  p_username text, p_display_name text, p_password text
)
returns table (id uuid, username text, display_name text, active boolean, created_at timestamptz)
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  insert into admins (username, display_name, password_hash)
  values (p_username, p_display_name, crypt(p_password, gen_salt('bf', 10)))
  returning admins.id, admins.username, admins.display_name, admins.active, admins.created_at;
$$;

create or replace function api_set_admin_password(p_admin_id uuid, p_password text)
returns void
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  update admins set password_hash = crypt(p_password, gen_salt('bf', 10)) where id = p_admin_id;
$$;

/* ------------------------------------------------------------- rotation, reachable and audited */

-- The two-argument form is replaced rather than overloaded: an added parameter with a default
-- would make the old call ambiguous. Nothing called it - that was the defect.
drop function if exists api_set_operator_pin(uuid, text);

create function api_set_operator_pin(
  p_operator_id uuid,
  p_pin         text,
  p_admin_id    uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare v_event uuid; v_user text;
begin
  if p_pin is null or length(btrim(p_pin)) < 4 then
    raise exception 'PIN_TOO_SHORT' using hint = 'A PIN is at least four characters.';
  end if;

  update operators
     set pin_hash = crypt(p_pin, gen_salt('bf', 10))
   where id = p_operator_id
  returning event_id, username into v_event, v_user;

  if v_event is null then
    raise exception 'UNKNOWN_OPERATOR' using hint = 'No operator with that id.';
  end if;

  -- The new PIN is never recorded, only the fact of the change and who made it.
  if p_admin_id is not null then
    perform log_override_admin(v_event, p_admin_id, 'set_operator_pin', 'operator', p_operator_id,
                               null, jsonb_build_object('username', v_user), null);
  else
    perform log_override(v_event, null, 'set_operator_pin', 'operator', p_operator_id,
                         null, jsonb_build_object('username', v_user), null);
  end if;
end;
$$;

comment on function api_set_operator_pin(uuid, text, uuid) is
  'Law 6 repairable: rotates one operator PIN at cost 10 and records who did it, never what to.';

create or replace function api_set_operator_active(
  p_operator_id uuid,
  p_active      boolean,
  p_admin_id    uuid default null
)
returns table (id uuid, event_id uuid, username text, display_name text, booth text,
               role text, active boolean, last_seen_at timestamptz, created_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_event uuid; v_user text; v_was boolean;
begin
  -- Every column reference here is alias-qualified on purpose: the OUT parameters declared by
  -- `returns table (id, event_id, username, active, ...)` shadow the columns of the same name,
  -- which is the runtime ambiguity 0020 had to fix once already.
  select o.event_id, o.username, o.active into v_event, v_user, v_was
    from operators o where o.id = p_operator_id;
  if v_event is null then
    raise exception 'UNKNOWN_OPERATOR' using hint = 'No operator with that id.';
  end if;

  update operators o set active = p_active where o.id = p_operator_id;

  if p_admin_id is not null then
    perform log_override_admin(v_event, p_admin_id,
                               case when p_active then 'reactivate_operator' else 'deactivate_operator' end,
                               'operator', p_operator_id,
                               jsonb_build_object('active', v_was),
                               jsonb_build_object('active', p_active, 'username', v_user), null);
  else
    perform log_override(v_event, null,
                         case when p_active then 'reactivate_operator' else 'deactivate_operator' end,
                         'operator', p_operator_id,
                         jsonb_build_object('active', v_was),
                         jsonb_build_object('active', p_active, 'username', v_user), null);
  end if;

  -- Same pin-free shape as every other operator-returning function.
  return query select o.id, o.event_id, o.username, o.display_name, o.booth, o.role,
                      o.active, o.last_seen_at, o.created_at
                 from operators o where o.id = p_operator_id;
end;
$$;

comment on function api_set_operator_active(uuid, boolean, uuid) is
  'Retires or restores an operator account. verify_operator has required active = true since 0011, so this is a real revocation, not a UI courtesy.';

/* ------------------------------------------------- the seed mints, rather than publishes, a PIN */

create or replace function seed_demo_event(
  p_slug     text default 'rehearsal',
  p_name     text default 'Dress Rehearsal',
  p_operator text default 'booth1',
  p_pin      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event uuid;
  v_op    uuid;
  v_made  boolean := false;
  v_pin   text := p_pin;
  v_new   boolean := false;
begin
  select id into v_event from events where slug = p_slug;

  if v_event is null then
    insert into events (slug, name, name_en, name_ar, status, guest_mode, shirt_options,
                        brand_primary, brand_secondary, locale_default)
    values (p_slug, p_name, p_name, 'بروفة', 'live', 'code_per_shot',
            '[{"id":"white-classic","en":"Classic White","ar":"أبيض كلاسيكي"},
               {"id":"navy","en":"Navy","ar":"كحلي"},
               {"id":"black-tee","en":"Black Tee","ar":"أسود"}]'::jsonb,
            '#e8c07a', '#111111', 'ar')
    returning id into v_event;
    v_made := true;
  end if;

  -- Idempotent throughout: a second run adds nothing, so a rehearsal can be re-seeded
  -- without producing a second set of anything.
  select id into v_op from operators where event_id = v_event and username = p_operator;
  if v_op is null then
    if v_pin is null then
      -- No constant. Six unbiased digits from gen_random_bytes, minted here and returned
      -- once - the only moment this credential is ever readable.
      v_pin := lpad(((get_byte(gen_random_bytes(3), 0)::bigint * 65536
                    + get_byte(gen_random_bytes(3), 1)::bigint * 256
                    + get_byte(gen_random_bytes(3), 2)::bigint) % 1000000)::text, 6, '0');
    end if;
    v_new := true;
    select id into v_op from api_create_operator(v_event, p_operator, 'Booth One', 'A', 'operator', v_pin);
  end if;

  if not exists (select 1 from show_cues where event_id = v_event) then
    perform api_save_cue(null, v_event, 1, 'Doors open',        'فتح الأبواب');
    perform api_save_cue(null, v_event, 2, 'Walls live',        'تشغيل الجدران');
    perform api_save_cue(null, v_event, 3, 'Headline moment',   'اللحظة الرئيسية');
    perform api_save_cue(null, v_event, 4, 'Last call for photos', 'آخر فرصة للتصوير');
  end if;

  if not exists (select 1 from crew_tasks where event_id = v_event) then
    perform api_save_task(null, v_event, 'Charge every tablet to 100%', 'Booth crew');
    perform api_save_task(null, v_event, 'Open the wall screens and leave them open', 'AV');
    perform api_save_task(null, v_event, 'Print the QR kit and place the stands', 'Floor');
    perform api_save_task(null, v_event, 'Confirm the control room can see every station', 'Ops');
  end if;

  return jsonb_build_object(
    'eventId', v_event, 'slug', p_slug, 'created', v_made,
    'operator', p_operator,
    -- Present only on the run that actually created the account, and only when this function
    -- chose the PIN. Write it down; it is not recoverable, only replaceable.
    'pin', case when v_new and p_pin is null then v_pin else null end,
    'cues', (select count(*) from show_cues where event_id = v_event),
    'tasks', (select count(*) from crew_tasks where event_id = v_event)
  );
end;
$$;

comment on function seed_demo_event(text, text, text, text) is
  'Repeatable rehearsal seed. Mints a random PIN when none is supplied and returns it once; it publishes no constant credential.';

/* ------------------------------------------------------------------- the law 6 gate, widened */

create or replace function gate_credentials()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  a uuid; op uuid; adm uuid; n integer; t text; ok boolean; js jsonb;
begin
  perform gate_cleanup();

  /* ---- the hole that was missed: a credential readable in the schema ---- */

  area := 'law 6'; check_name := 'no function publishes a credential as a parameter default';
  select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proargdefaults is not null
     and exists (
       select 1
         from unnest(coalesce(p.proargnames, '{}'::text[])) as an(name)
        where an.name ~* '(pin|password|secret|token|passphrase)'
     )
     and pg_get_expr(p.proargdefaults, p.pronamespace) ~ '''[^'']{3,}''';
  expected := '0 functions'; actual := n::text; pass := (n = 0); return next;

  area := 'law 6'; check_name := 'the rehearsal seed no longer carries a constant PIN';
  select pg_get_function_arguments(p.oid) into t
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'seed_demo_event';
  expected := 'p_pin defaults to NULL'; actual := coalesce(t, '(missing)');
  pass := (t is not null and t ~* 'p_pin text DEFAULT NULL'); return next;

  /* ---- and that the seed still works, minting instead of publishing ---- */

  js := seed_demo_event('gate-seed', 'Gate Seed', 'gateseed', null);

  area := 'law 6'; check_name := 'the seed mints a PIN and returns it exactly once';
  expected := 'six digits'; actual := coalesce(js->>'pin', '(none)');
  pass := (coalesce(js->>'pin', '') ~ '^[0-9]{6}$'); return next;

  area := 'law 6'; check_name := 'and the minted PIN actually signs its operator in';
  select outcome into t from verify_operator('gate-seed', 'gateseed', js->>'pin', 'gate-device');
  expected := 'ok'; actual := coalesce(t, '(none)'); pass := (t = 'ok'); return next;

  area := 'law 6'; check_name := 're-running the seed does not re-issue a credential';
  js := seed_demo_event('gate-seed', 'Gate Seed', 'gateseed', null);
  expected := 'no pin returned'; actual := coalesce(js->>'pin', 'null');
  pass := (js->>'pin' is null); return next;

  /* ---- work factor ---- */

  insert into events (slug, name, status) values ('gate-cred', 'Gate Cred', 'live') returning id into a;
  select id into op from api_create_operator(a, 'gatecred', 'Gate Cred', 'A', 'operator', '135790');
  select id into adm from api_create_admin('gateadmin-cred', 'Gate Admin', 'gate-password-1');

  area := 'law 6'; check_name := 'a new operator hash is bcrypt cost 10, not pgcrypto''s default 6';
  select left(pin_hash, 7) into t from operators where id = op;
  expected := '$2a$10$'; actual := coalesce(t, '(none)'); pass := (t = '$2a$10$'); return next;

  area := 'law 6'; check_name := 'a new admin hash is cost 10 too';
  select left(password_hash, 7) into t from admins where id = adm;
  expected := '$2a$10$'; actual := coalesce(t, '(none)'); pass := (t = '$2a$10$'); return next;

  /* ---- rotation exists, works, and is audited ---- */

  perform api_set_operator_pin(op, '246810', adm);

  area := 'law 6'; check_name := 'a rotated PIN takes effect';
  select outcome into t from verify_operator('gate-cred', 'gatecred', '246810', 'gate-device');
  expected := 'ok'; actual := t; pass := (t = 'ok'); return next;

  area := 'law 6'; check_name := 'and the PIN it replaced stops working';
  select outcome into t from verify_operator('gate-cred', 'gatecred', '135790', 'gate-device2');
  expected := 'bad_credentials'; actual := t; pass := (t = 'bad_credentials'); return next;

  area := 'feature E'; check_name := 'the rotation is in the audit trail, attributed to the admin';
  select count(*) into n from audit_log
   where event_id = a and action = 'set_operator_pin' and actor_kind = 'admin';
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  area := 'law 6'; check_name := 'the audit trail records the change, never the new credential';
  select (after::text || coalesce(before::text, '')) into t from audit_log
   where event_id = a and action = 'set_operator_pin' limit 1;
  expected := 'no PIN in the record'; actual := case when t like '%246810%' then 'LEAKED' else 'absent' end;
  pass := (t not like '%246810%'); return next;

  area := 'law 6'; check_name := 'a PIN below the floor is refused';
  begin
    perform api_set_operator_pin(op, '12', adm);
    ok := false;
  exception when others then ok := (sqlerrm = 'PIN_TOO_SHORT');
  end;
  expected := 'refused'; actual := case when ok then 'refused' else 'ALLOWED' end; pass := ok; return next;

  /* ---- and an account can actually be retired ---- */

  perform api_set_operator_active(op, false, adm);

  area := 'feature B'; check_name := 'a deactivated operator cannot sign in with a correct PIN';
  select outcome into t from verify_operator('gate-cred', 'gatecred', '246810', 'gate-device3');
  expected := 'bad_credentials'; actual := t; pass := (t = 'bad_credentials'); return next;

  area := 'feature E'; check_name := 'the deactivation is audited with its actor';
  select count(*) into n from audit_log
   where event_id = a and action = 'deactivate_operator' and actor_kind = 'admin';
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  perform api_set_operator_active(op, true, adm);

  area := 'feature B'; check_name := 'and can be restored';
  select outcome into t from verify_operator('gate-cred', 'gatecred', '246810', 'gate-device4');
  expected := 'ok'; actual := t; pass := (t = 'ok'); return next;

  perform gate_cleanup();
  delete from events where slug = 'gate-seed';
  return;
end;
$$;

comment on function gate_credentials() is
  'Law 6, widened past "is it hashed" to "is it readable, rotatable, revocable, and strong enough" - the four questions the original two checks did not ask.';

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
    from gate_phase_5() g
  union all
  select 'phase 5'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_branding() g
  union all
  select 'phase 6'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_phase_6() g
  union all
  select 'phase 6'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_shirt_catalogue() g
  union all
  select 'phase 7'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_thumbnails() g
  union all
  select 'phase 7'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_reachability() g
  union all
  select 'phase 7'::text, g.area, g.check_name, g.expected, g.actual, g.pass
    from gate_credentials() g;
$$;

select apply_function_grants();

do $$
declare v_fails integer;
begin
  select count(*) into v_fails from run_all_gates() where not pass;
  if v_fails > 0 then
    raise exception 'gate suite red after 0031: % failing check(s)', v_fails;
  end if;
end
$$;
