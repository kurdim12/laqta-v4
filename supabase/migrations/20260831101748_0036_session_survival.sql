-- 0036 — session survival, asserted against the deployed function.
--
-- Outcome gate 3: "yesterday's sign-in survives showtime unattended; expiry during an outage
-- cannot strand the outbox."
--
-- The second half is client behaviour and is proved in the browser. The first half is a
-- CONSTANT INSIDE THE DEPLOYED EDGE FUNCTION — and constants inside a deployed function are
-- exactly the kind of thing that quietly reverts. The browser suite runs against a mock, so it
-- can only prove the client adopts what it is given; asserting the mock's own lifetime would
-- prove nothing about production.
--
-- So the deployed function reports its own configuration into sweeper_runs on every hourly
-- self-test, and this gate reads it. If someone redeploys a twelve-hour session, the suite goes
-- red within the hour — which is the only version of this check worth having.

create or replace function gate_sessions()
returns table(area text, check_name text, expected text, actual text, pass boolean)
language plpgsql security definer set search_path = public, pg_temp
as $function$
declare d jsonb; v_at timestamptz; hrs numeric; refresh_at numeric;
begin
  select detail, ran_at into d, v_at from sweeper_runs
   where sweeper = 'storage_selftest_probe'
   order by ran_at desc limit 1;

  hrs := nullif(d->>'sessionHours', '')::numeric;
  refresh_at := nullif(d->>'sessionRefreshAfter', '')::numeric;

  -- A station is set up the evening before and asked to work through the following night with
  -- nobody logging back in. Twelve hours expires it somewhere around the second guest.
  area := 'law 6'; check_name := 'the deployed API grants a session that outlives a night-before setup';
  expected := '>= 24 hours'; actual := coalesce(hrs::text || ' hours', '(not reported by the deployed function)');
  pass := (hrs is not null and hrs >= 24); return next;

  -- And the other direction, because a credential that never dies is not a session. A tablet
  -- left in a box for a week has to ask for its PIN again.
  area := 'law 6'; check_name := 'and one that still expires on a tablet nobody is using';
  expected := '<= 72 hours'; actual := coalesce(hrs::text || ' hours', '(not reported)');
  pass := (hrs is not null and hrs <= 72); return next;

  -- Length alone would be the lazy fix. The slide is what makes a working station never expire
  -- under the person using it, while an abandoned one still does.
  area := 'law 1'; check_name := 'a session in use is reissued before it is half spent';
  expected := 'reissue at <= 0.5 of lifetime';
  actual := coalesce(refresh_at::text, '(not reported)');
  pass := (refresh_at is not null and refresh_at > 0 and refresh_at <= 0.5); return next;

  area := 'law 13'; check_name := 'that report comes from a deploy this week, not a memory';
  expected := 'newer than 7 days'; actual := coalesce(age(now(), v_at)::text, '(never)');
  pass := (v_at is not null and v_at > now() - interval '7 days'); return next;

  return;
end;
$function$;

-- What the control room and the event-day checklist read, so the owner can see the storage
-- proof without a terminal: the newest self-test, its verdict, and how old it is. Nothing here
-- names a bucket path or a secret; it is a yes/no and a timestamp.
create or replace function api_storage_verdict()
returns table(proven_at timestamptz, ok boolean, age_seconds integer)
language sql stable security definer set search_path = public, pg_temp
as $function$
  select s.ran_at,
         (s.detail->>'uploadStatus' = '200'
          and (s.detail->>'bytesMatch')::boolean is true
          and (s.detail->>'urlStable')::boolean is true
          and (s.detail->>'deleted')::boolean is true),
         extract(epoch from (now() - s.ran_at))::integer
    from sweeper_runs s
   where s.sweeper = 'storage_selftest_probe'
   order by s.ran_at desc
   limit 1;
$function$;

revoke all on function api_storage_verdict() from public, anon, authenticated;
revoke all on function gate_sessions() from public, anon, authenticated;

-- Registered in the suite. gate_sessions is deliberately BLOCKING, not optional: a missing
-- report means the deployed function no longer says what its session lifetime is, and that is
-- the same news as a bad lifetime.
create or replace function run_gate_checks()
returns table(phase text, area text, check_name text, expected text, actual text, pass boolean)
language sql security definer set search_path = public, pg_temp
as $function$
  select 'phase 0'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from run_phase_0_gate() g
  union all select 'phase 0'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_phase_0_capture() g
  union all select 'phase 1'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_phase_1() g
  union all select 'phase 2'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_phase_2() g
  union all select 'phase 3'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_phase_3() g
  union all select 'phase 4'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_phase_4() g
  union all select 'phase 5'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_phase_5() g
  union all select 'phase 5'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_branding() g
  union all select 'phase 6'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_phase_6() g
  union all select 'phase 6'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_shirt_catalogue() g
  union all select 'phase 7'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_thumbnails() g
  union all select 'phase 7'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_reachability() g
  union all select 'phase 7'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_credentials() g
  union all select 'audit'::text,   g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_moderation_scope() g
  union all select 'audit'::text,   g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_storage() g
  union all select 'outcome'::text, g.area, g.check_name, g.expected, g.actual, coalesce(g.pass, false) from gate_sessions() g;
$function$;
