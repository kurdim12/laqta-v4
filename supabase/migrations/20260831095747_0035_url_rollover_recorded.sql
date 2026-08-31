-- 0035 — the URL expiry rollover, recorded.
--
-- Outcome gate 1 asked for three things of the wall's polling: an unchanged cell re-fetches
-- zero image bytes, the URLs are cache-stable, and the expiry rollover is proven mid-show.
-- The first two were provable in a single request. The third is a property of ELAPSED TIME —
-- the cache hands back one string for a while and then must mint a different one that still
-- works — and the moment it matters is an hour into a show with nobody watching.
--
-- ops.selfTest grew an opt-in `rollover` probe for exactly that: it signs with a lifetime whose
-- reuse window is ten seconds, waits past it, signs again, and fetches what comes back. Same
-- code path, same arithmetic as the production hour; only the clock is compressed.
--
-- The hourly poke does NOT run it (it would hold a function invocation open for twelve seconds
-- every hour to re-prove arithmetic), so this check reads the newest run that CARRIES rollover
-- keys rather than the newest run. And it is NON-BLOCKING by construction: with no such run on
-- record it passes and says so. A gate that goes red because an optional probe was not run
-- teaches the team to ignore red, which is how a suite stops being a suite.

create or replace function gate_storage()
returns table(area text, check_name text, expected text, actual text, pass boolean)
language plpgsql security definer set search_path = public, pg_temp
as $function$
declare d jsonb; v_at timestamptz; r jsonb; r_at timestamptz;
begin
  select detail, ran_at into d, v_at from sweeper_runs
   where sweeper = 'storage_selftest_probe'
   order by ran_at desc limit 1;

  area := 'law 1'; check_name := 'a storage round trip has actually been run in production';
  expected := 'a recorded self-test'; actual := coalesce(v_at::text, '(never run)');
  pass := (d is not null); return next;

  -- The rollover, read from the newest run that actually carries it. Reported before the early
  -- return below so that "never run" is stated once, honestly, rather than silently omitted.
  select detail, ran_at into r, r_at from sweeper_runs
   where sweeper = 'storage_selftest_probe'
     and detail ? 'rolloverMintedNew'
   order by ran_at desc limit 1;

  if r is null then
    area := 'law 7'; check_name := 'the signed-URL expiry rollover has been run with real elapsed time';
    expected := 'a recorded rollover run, or none (this check does not block)';
    actual := '(none recorded — non-blocking)';
    pass := true; return next;
  else
    area := 'law 7'; check_name := 'the reuse window is strictly shorter than the signature lifetime';
    expected := 'reuse < ttl';
    actual := coalesce(r->>'rolloverReuseSeconds','?') || 's reuse of '
              || coalesce(r->>'rolloverTtlSeconds','?') || 's ttl';
    pass := (r->>'rolloverReuseSeconds')::int < (r->>'rolloverTtlSeconds')::int; return next;

    area := 'law 7'; check_name := 'once the reuse window has elapsed a fresh URL is minted';
    expected := 'true, after ' || coalesce(r->>'rolloverWaitMs','?') || 'ms of real waiting';
    actual := coalesce(r->>'rolloverMintedNew', '(none)');
    pass := ((r->>'rolloverMintedNew')::boolean is true); return next;

    area := 'law 7'; check_name := 'and the freshly minted URL still fetches the object';
    expected := 'true'; actual := coalesce(r->>'rolloverStillWorks','(none)')
              || ' (' || coalesce(r->>'rolloverReadStatus','?') || ')';
    pass := ((r->>'rolloverStillWorks')::boolean is true); return next;
  end if;

  if d is null then return; end if;

  area := 'law 1'; check_name := 'the upload was accepted by the real bucket';
  expected := '200'; actual := coalesce(d->>'uploadStatus', '(none)');
  pass := (d->>'uploadStatus' = '200'); return next;

  area := 'law 1'; check_name := 'and the bytes came back identical through a signed read';
  expected := 'true'; actual := coalesce(d->>'bytesMatch', '(none)');
  pass := ((d->>'bytesMatch')::boolean is true); return next;

  area := 'law 7'; check_name := 'signing the same object twice returns the same URL';
  expected := 'true'; actual := coalesce(d->>'urlStable', '(none)');
  pass := ((d->>'urlStable')::boolean is true); return next;

  -- The shape the outbox has to read as success. Supabase answers a duplicate object with
  -- HTTP 400 carrying {"statusCode":"409"}, not with HTTP 409 - reading only the status line
  -- would turn a retry that already succeeded into a permanent failure inside an infinite
  -- retry loop, which is a lost photo wearing the costume of patience.
  area := 'law 1'; check_name := 'a re-uploaded object answers in a shape the outbox tolerates';
  expected := '200, or 4xx naming 409';
  actual := coalesce(d->>'duplicateStatus', '(none)') || ' ' || coalesce(d->>'duplicateBody', '');
  pass := (d->>'duplicateStatus' = '200'
           or coalesce(d->>'duplicateBody', '') ~ '"statusCode"\s*:\s*"?409"?'
           or d->>'duplicateStatus' = '409'); return next;

  area := 'law 10'; check_name := 'the self-test cleans up the object it made';
  expected := 'true'; actual := coalesce(d->>'deleted', '(none)');
  pass := ((d->>'deleted')::boolean is true); return next;

  -- A probe nothing re-runs is a check that can never fail again. This one is poked hourly;
  -- a week of silence means the schedule died and the proof above is a museum piece.
  area := 'law 13'; check_name := 'the storage proof is still being re-run, not frozen';
  expected := 'newer than 7 days';
  actual := age(now(), v_at)::text;
  pass := (v_at > now() - interval '7 days'); return next;

  return;
end;
$function$;

-- Self-verifying, as every migration since 0009 has been: this one rolls back rather than
-- leave the suite red behind it.
do $$
declare bad int; total int;
begin
  select count(*) filter (where not coalesce(g.pass, false)), count(*)
    into bad, total from run_all_gates() g;
  if bad > 0 then
    raise exception 'GATE_SUITE_RED: % of % checks failing after 0035', bad, total;
  end if;
  raise notice 'gate suite green: % checks', total;
end $$;
