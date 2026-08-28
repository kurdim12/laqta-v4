-- 0015_phase_0_gate.sql
--
-- Law 13: "every phase gate is an executable check that stays in the repo and re-runs before
-- every later phase report". This installs that check as run_phase_0_gate().
--
-- It is a function rather than a script for one reason: a script can drift from the database
-- it claims to test, and a script that needs a terminal is a script the owner can never run.
-- This travels with the schema, is versioned in this repo like everything else, and is called
-- with one line.
--
-- It builds its own throwaway event, attacks it, and deletes everything it made. Everything it
-- does happens inside the caller's transaction, so a failure severe enough to raise takes the
-- test data with it rather than leaving wreckage behind.
--
-- Append-only. Never edit a migration that has been applied; add a new one.

create or replace function gate_cleanup()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_ids from events where slug like 'gate-%';
  delete from guest_codes            where event_id = any(v_ids);
  delete from ai_jobs                where event_id = any(v_ids);
  delete from photos                 where event_id = any(v_ids);
  delete from guests                 where event_id = any(v_ids);
  delete from audit_log              where event_id = any(v_ids);
  delete from ops_events             where event_id = any(v_ids);
  delete from ops_quota              where event_id = any(v_ids);
  delete from rate_limits            where event_id = any(v_ids);
  delete from operator_login_attempts where event_id = any(v_ids);
  delete from stations               where event_id = any(v_ids);
  delete from operators              where event_id = any(v_ids);
  delete from events                 where id = any(v_ids);
  delete from platform_rate_limits   where subject like 'gate-%';
  delete from admins                 where username like 'gateadmin%';
  delete from sweeper_runs           where sweeper like 'gate_%';
end;
$$;

create or replace function run_phase_0_gate()
returns table (area text, check_name text, expected text, actual text, pass boolean)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  a uuid; b uuid; opA uuid; opB uuid; adm uuid;
  ph uuid; ph2 uuid; jb uuid; gc record;
  i integer; n integer; t text; ok boolean; res jsonb;
begin
  perform gate_cleanup();

  /* ============================================================ structure and access */

  area := 'structure'; check_name := 'schema lock assertion is clean';
  select count(*) into n from assert_schema_locked();
  expected := '0 violations'; actual := n || ' violations'; pass := (n = 0); return next;

  area := 'structure'; check_name := 'every table in public has RLS';
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  expected := '0 without RLS'; actual := n::text; pass := (n = 0); return next;

  area := 'law 9'; check_name := 'the public anon key can execute nothing';
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  expected := '0 callable'; actual := n::text; pass := (n = 0); return next;

  area := 'law 6'; check_name := 'no function returns a credential';
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and pg_get_function_result(p.oid) ~* '(pin_hash|password_hash)';
  expected := '0 functions'; actual := n::text; pass := (n = 0); return next;

  area := 'law 7'; check_name := 'the wall type cannot name an original';
  select pg_get_function_result(p.oid) into t from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'wall_photos';
  expected := 'no storage_path'; actual := coalesce(t, '(missing)');
  pass := (t is not null and t !~ 'storage_path'); return next;

  /* ================================================================== the walking spine */

  insert into events (slug, name, status, telemetry_cap_per_device_hour, upload_ttl_minutes)
  values ('gate-alpha', 'Gate Alpha', 'live', 10, 1) returning id into a;
  insert into events (slug, name, status) values ('gate-beta', 'Gate Beta', 'live') returning id into b;

  area := 'spine'; check_name := 'an event can be created';
  expected := 'draft or live row'; actual := (select status from events where id = a);
  pass := (a is not null); return next;

  select id into opA from api_create_operator(a, 'gateop', 'Gate Op', 'A', 'operator', '4821');
  select id into opB from api_create_operator(b, 'gateopb', 'Gate Op B', 'A', 'operator', '1234');

  area := 'spine'; check_name := 'an operator logs in with a bcrypt PIN';
  select outcome into t from verify_operator('gate-alpha', 'gateop', '4821', 'gate-device');
  expected := 'ok'; actual := t; pass := (t = 'ok'); return next;

  area := 'law 6'; check_name := 'the PIN is stored only as a bcrypt hash';
  select pin_hash into t from operators where id = opA;
  expected := 'bcrypt $2 prefix, never the PIN';
  actual := left(coalesce(t, ''), 4);
  pass := (t like '$2%' and t not like '%4821%'); return next;

  -- capture, twice, with the same client-minted id
  ph := gen_random_uuid();
  perform api_upsert_photo_if_absent(ph, a, opA, 'original', 'o/gate.jpg', 't/gate.jpg', 1234);
  perform api_upsert_photo_if_absent(ph, a, opA, 'original', 'o/gate.jpg', 't/gate.jpg', 1234);

  area := 'law 1'; check_name := 'a retried upload cannot become a second photo';
  select count(*) into n from photos where id = ph;
  expected := '1 row'; actual := n || ' rows'; pass := (n = 1); return next;

  perform api_confirm_photo(ph);

  area := 'spine'; check_name := 'an unapproved photo is absent from the wall';
  select count(*) into n from wall_photos('gate-alpha', 60);
  expected := '0 on the wall'; actual := n::text; pass := (n = 0); return next;

  area := 'law E'; check_name := 'the publish gate is enforced by the database';
  begin
    update photos set status = 'processing' where id = ph;
    update photos set approved = true where id = ph;
    ok := false;
  exception when others then
    ok := (sqlerrm like '%PHOTO_NOT_READY%');
  end;
  update photos set status = 'ready' where id = ph;
  expected := 'a direct write is refused'; actual := case when ok then 'refused' else 'ALLOWED' end;
  pass := ok; return next;

  perform approve_photo(ph, opA);

  area := 'spine'; check_name := 'an approved photo reaches the wall';
  select count(*) into n from wall_photos('gate-alpha', 60);
  expected := '1 on the wall'; actual := n::text; pass := (n = 1); return next;

  area := 'law E'; check_name := 'the approval is in the audit trail';
  select count(*) into n from audit_log where event_id = a and action = 'approve';
  expected := '>= 1'; actual := n::text; pass := (n >= 1); return next;

  area := 'law 7'; check_name := 'a photo cannot be ready without a thumbnail';
  begin
    insert into photos (id, event_id, operator_id, kind, storage_path, bytes, status)
    values (gen_random_uuid(), a, opA, 'original', 'o/nothumb.jpg', 10, 'ready');
    ok := false;
  exception when others then ok := true;
  end;
  expected := 'refused'; actual := case when ok then 'refused' else 'ALLOWED' end;
  pass := ok; return next;

  /* ========================================================================= law 3 */

  for i in 1..500 loop
    perform record_op('booth', 'upload_failed', false, null, a,
                      jsonb_build_object('code', 'E_NET', 'error', 'network down'), 'gate-tablet');
  end loop;

  area := 'law 3'; check_name := '500 identical errors collapse to one row';
  select count(*) into n from ops_events where event_id = a and device_id = 'gate-tablet';
  expected := '1 row'; actual := n || ' rows'; pass := (n = 1); return next;

  area := 'law 3'; check_name := 'the occurrences are still counted';
  select coalesce(sum(ops_events.n), 0) into n from ops_events
   where event_id = a and device_id = 'gate-tablet';
  expected := '500'; actual := n::text; pass := (n = 500); return next;

  for i in 1..50 loop
    perform record_op('booth', 'weird', false, null, a,
                      jsonb_build_object('code', 'E_' || i::text), 'gate-tablet2');
  end loop;

  area := 'law 3'; check_name := '50 distinct errors are capped at the event cap plus a marker';
  select count(*) into n from ops_events where event_id = a and device_id = 'gate-tablet2';
  expected := '11 rows (cap 10 + marker)'; actual := n || ' rows'; pass := (n = 11); return next;

  area := 'law 3'; check_name := 'the cap drops detail but counts what it dropped';
  select dropped into n from ops_quota where event_id = a and device_id = 'gate-tablet2';
  expected := '40 dropped'; actual := n::text; pass := (n = 40); return next;

  area := 'law 3'; check_name := 'the marker keeps the signal alive';
  select ops_events.n into n from ops_events
   where event_id = a and device_id = 'gate-tablet2' and fingerprint = 'capped';
  expected := '40'; actual := coalesce(n::text, 'no marker'); pass := (n = 40); return next;

  area := 'law 3'; check_name := 'telemetry failure cannot block the caller';
  begin
    perform record_op('booth', 'ghost', false, null,
                      '00000000-0000-0000-0000-000000000000'::uuid, '{}'::jsonb, 'gate-ghost');
    ok := true;
  exception when others then ok := false;
  end;
  expected := 'caller survives'; actual := case when ok then 'survived' else 'RAISED' end;
  pass := ok; return next;

  /* ========================================================================= law 5 */

  perform api_set_event_switches(a, true, true, true, true, true, 'x', 'س', opA, null);

  area := 'law 5'; check_name := 'flipping every switch on one event touches no other';
  select (wall_frozen or panic_brand_only or intake_paused or ai_paused or banner_active)
    into ok from events where id = b;
  expected := 'the other event unchanged';
  actual := case when ok then 'LEAKED' else 'unchanged' end;
  pass := not ok; return next;

  area := 'law 5'; check_name := 'a paused intake refuses the write';
  begin
    perform api_upsert_photo_if_absent(gen_random_uuid(), a, opA, 'original', 'o/x.jpg', 't/x.jpg', 1);
    ok := false;
  exception when others then ok := (sqlerrm = 'INTAKE_PAUSED');
  end;
  expected := 'refused'; actual := case when ok then 'refused' else 'ALLOWED' end;
  pass := ok; return next;

  area := 'law 5'; check_name := 'the same call still works on the other event';
  begin
    perform api_upsert_photo_if_absent(gen_random_uuid(), b, opB, 'original', 'o/y.jpg', 't/y.jpg', 1);
    ok := true;
  exception when others then ok := false;
  end;
  expected := 'accepted'; actual := case when ok then 'accepted' else 'BLOCKED' end;
  pass := ok; return next;

  area := 'law 5'; check_name := 'panic empties the wall';
  select count(*) into n from wall_photos('gate-alpha', 60);
  expected := '0'; actual := n::text; pass := (n = 0); return next;

  -- lift panic; freeze with an instant in the past so the freeze can be tested inside one
  -- transaction, where now() would otherwise be identical for the freeze and the photo
  update events set panic_brand_only = false, wall_frozen = true,
                    wall_frozen_at = now() - interval '1 hour'
   where id = a;

  area := 'law 5'; check_name := 'a frozen wall does not advance';
  select count(*) into n from wall_photos('gate-alpha', 60);
  expected := '0 (the photo is newer than the freeze)'; actual := n::text; pass := (n = 0); return next;

  update events set wall_frozen = false, wall_frozen_at = null, intake_paused = false,
                    ai_paused = false, banner_active = false where id = a;

  area := 'law 5'; check_name := 'the wall recovers when the freeze is lifted';
  select count(*) into n from wall_photos('gate-alpha', 60);
  expected := '1'; actual := n::text; pass := (n = 1); return next;

  /* ====================================================================== laws 6 and 12 */

  for i in 1..12 loop
    select outcome into t from verify_operator('gate-alpha', 'gateop', '0000', 'gate-device');
  end loop;

  area := 'law 6'; check_name := 'the correct PIN is refused while locked out';
  select outcome into t from verify_operator('gate-alpha', 'gateop', '4821', 'gate-device');
  expected := 'locked_out'; actual := t; pass := (t = 'locked_out'); return next;

  select id into adm from api_create_admin('gateadmin', 'Gate Admin', 'gate-password');
  perform api_unlock_operator(a, 'gateop', adm);

  area := 'law 6'; check_name := 'an admin can lift a lockout mid-event';
  select outcome into t from verify_operator('gate-alpha', 'gateop', '4821', 'gate-device');
  expected := 'ok'; actual := t; pass := (t = 'ok'); return next;

  area := 'law 12'; check_name := 'every rate counter is a table, not memory';
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r'
     and c.relname in ('rate_limits', 'platform_rate_limits', 'ops_quota', 'operator_login_attempts');
  expected := '4 tables'; actual := n::text; pass := (n = 4); return next;

  /* ============================================================================ law 11 */

  select * into gc from api_mint_guest_code(a, ph, null, opA, 24);

  area := 'law 11'; check_name := 'a guest code is 14 symbols of unambiguous base32';
  expected := '14 chars, no I/L/O/U'; actual := gc.code;
  pass := (gc.code ~ '^[0-9A-HJKMNP-TV-Z]{14}$'); return next;

  for i in 1..35 loop
    select outcome into t from api_guest_lookup('ZZZZZZZZZZZZ' || lpad(i::text, 2, '0'), 'gate-attacker', 30);
  end loop;

  area := 'law 11'; check_name := 'bulk guessing is refused';
  expected := 'rate_limited'; actual := t; pass := (t = 'rate_limited'); return next;

  area := 'law 11'; check_name := 'a real code from another client still resolves';
  select outcome into t from api_guest_lookup(gc.code, 'gate-guest', 30);
  expected := 'ok'; actual := t; pass := (t = 'ok'); return next;

  area := 'law E'; check_name := 'the gallery hides unapproved photos from the guest';
  ph2 := gen_random_uuid();
  insert into photos (id, event_id, operator_id, kind, storage_path, thumb_path, bytes, status)
  values (ph2, a, opA, 'original', 'o/pending.jpg', 't/pending.jpg', 10, 'ready');
  perform api_mint_guest_code(a, ph2, null, opA, 24);
  select count(*) into n from api_guest_photos(gc.code);
  expected := '1 (only the approved one)'; actual := n::text; pass := (n = 1); return next;

  /* ============================================================================ law 10 */

  update photos set status = 'processing', approved = false, approved_by = null, approved_at = null,
                    created_at = now() - interval '10 minutes'
   where id = ph2;
  res := sweep_photos();

  area := 'law 10'; check_name := 'an abandoned upload is swept out of processing';
  select status into t from photos where id = ph2;
  expected := 'expired'; actual := t; pass := (t = 'expired'); return next;

  perform api_confirm_photo(ph2);

  area := 'law 10'; check_name := 'a late sync still lands (law 10 may not defeat law 1)';
  select status into t from photos where id = ph2;
  expected := 'ready'; actual := t; pass := (t = 'ready'); return next;

  select id into jb from api_enqueue_job(a, ph, opA);
  perform claim_ai_job(a, 'gate-worker');
  res := sweep_ai_jobs();

  area := 'law 4'; check_name := 'a live worker is not overtaken by the sweeper';
  select status into t from ai_jobs where id = jb;
  expected := 'running'; actual := t; pass := (t = 'running'); return next;

  update ai_jobs set lease_until = now() - interval '1 second' where id = jb;
  res := sweep_ai_jobs();

  area := 'law 10'; check_name := 'a dead worker''s job is reclaimed';
  select status into t from ai_jobs where id = jb;
  expected := 'queued'; actual := t; pass := (t = 'queued'); return next;

  area := 'law 10'; check_name := 'sweeps are visible even on quiet passes';
  select count(distinct sweeper) into n from sweeper_runs
   where sweeper in ('sweep_photos', 'sweep_ai_jobs');
  expected := '>= 2 sweepers reporting'; actual := n::text; pass := (n >= 2); return next;

  /* ============================================================================ law D */

  update events set ai_budget_usd = 0.10, max_generations = 1000 where id = a;
  ok := consume_generation(a, 0.04);
  ok := consume_generation(a, 0.04);
  ok := consume_generation(a, 0.04);

  area := 'feature D'; check_name := 'the dollar cap refuses the call that would cross it';
  expected := 'third call refused'; actual := case when ok then 'ALLOWED' else 'refused' end;
  pass := not ok; return next;

  perform gate_cleanup();
  return;
end;
$$;

comment on function run_phase_0_gate() is
  'Law 13. The Phase 0 gate, executable and re-runnable: select * from run_phase_0_gate(). Builds its own event, attacks it, cleans up.';

select apply_function_grants();

do $$
declare v_count integer;
begin
  select count(*) into v_count from assert_schema_locked();
  if v_count > 0 then
    raise exception 'schema lock assertion failed with % violation(s) after 0015', v_count;
  end if;
end
$$;
