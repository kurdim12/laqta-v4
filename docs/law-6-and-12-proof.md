# Laws 6 and 12, shown dead

**Run against the live database on 2026-08-28, immediately after migration `0011` was applied.**
The test built a throwaway event, an operator and an admin, attacked the login, and deleted everything after.

## The lockout is a gate, not a tally

| Check | Result |
|---|---|
| Attempt at which a wrong PIN starts being refused (limit is 8) | **9** |
| The **correct** PIN, offered while locked out | **refused** — `locked_out` |
| `api_operator_lock_state` reports the lock | **true**, with a retry time |
| Admin unlock clears it | **1 window cleared** |
| Login with the correct PIN immediately after the unlock | **ok** |
| The unlock written to the audit trail | **yes** — actor `unlockadmin (admin)`, target `boothop`, reason recorded |
| Admin login with the right password / a wrong one | **ok** / **bad_credentials** |

The third row is the one that matters. A lockout that counts failures but still lets a correct credential
through is theatre. This one refuses the right PIN while the window is open.

## No credential is reachable

| Check | Result |
|---|---|
| Functions whose return type mentions `pin_hash` or `password_hash` | **0** |
| Functions returning a whole `operators` or `admins` row | **0** |

Both counts are asserted from `pg_get_function_result` over every function in `public`, so adding a column to
either table later cannot silently widen a return type back open.

## Why the race is gone

The old `verify_operator` did `select coalesce(sum(a.fails), 0) ...` and then decided. Under READ COMMITTED a
burst of concurrent attempts all read the same pre-threshold number and all proceeded to test a PIN — the
adversarial pass found this and it was real.

The counter is now the gate. `consume_login_attempt` is a single `insert ... on conflict do update ...
returning fails`: the increment and the total are one statement, against one row per five-minute window rather
than per-minute rows summed at read time. Each concurrent attempt receives its own distinct number, and every
number past the limit is refused. There is no window between reading and deciding because there is no read.

## Why the booth can no longer be locked out of its own event

The only statement that cleared attempts used to run on successful login — exactly what a locked-out operator
cannot do. A tablet stuck retrying a wrong PIN would hold a booth operator out for as long as it kept retrying,
in the middle of a live event, with no override.

There is now `api_unlock_operator`, which clears the window and writes an `audit_log` row like any other
override, and `api_operator_lock_state`, so the control room can see who is locked and until when instead of
guessing.

## Law 12

Every limit is a database row. `rate_limits` is event-scoped, so one event cannot spend another's allowance;
`platform_rate_limits` carries the handful of genuinely platform-level limits, such as admin login, rather than
being allowed to put a null in an `event_id` column — which is precisely the hole law 5 closed in `ops_events`.
`sweep_rate_limits` trims all three counter tables on a schedule and writes a heartbeat on every pass.
