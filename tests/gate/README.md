# The Phase 0 gate

**One line runs it:**

```sql
select * from run_phase_0_gate();
```

It returns one row per check with `area`, `check_name`, `expected`, `actual` and `pass`. The gate passes only
when every `pass` is true.

## Why the gate is a database function and not a script

Law 13 asks for "an executable check that stays in the repo and re-runs before every later phase report". Three
things follow from that, and they pushed the gate into the database:

- **A script drifts from the schema it tests.** This one is installed by a migration, so it is versioned with
  the schema it checks and cannot describe a database that no longer exists.
- **The owner never opens a terminal.** A gate that needs a shell is a gate only the engineer can run.
- **It has to work against the real thing.** These checks run against the live database, not a mock — the
  lockout really locks, the sweeper really sweeps, and 500 telemetry writes really land.

The source is `supabase/migrations/20260828214445_0015_phase_0_gate.sql`. Later phases add checks in new
migrations; nothing is ever edited, so the suite only grows.

## What it does to your data

It creates its own event (`gate-alpha`, `gate-beta`), attacks it, and deletes everything it made — verified
after the run: every table back to zero rows. Everything happens inside the caller's transaction, so a failure
severe enough to raise takes the test data with it rather than leaving wreckage.

Two of its checks call the real sweepers, which are global by nature. That is the same work `pg_cron` already
does every minute, so running the gate does nothing to live data that the schedule was not going to do anyway.

## The 39 checks

| Area | What it proves |
|---|---|
| structure | The schema lock assertion is clean; every table in `public` has RLS |
| law 9 | The public anon key can execute **nothing** — one API layer, taken literally |
| law 1 | A retried upload with the same client-minted id cannot become a second photo |
| law 3 | 500 identical errors collapse to one row carrying 500; 50 distinct errors stop at the cap plus a marker; the drops are counted; telemetry failure does not raise to its caller |
| law 4 | A live worker holding a lease is not overtaken by the sweeper |
| law 5 | Every switch flipped on one event leaves the other untouched; a paused intake refuses the write while the same call succeeds elsewhere; panic empties the wall; a freeze holds and then recovers |
| law 6 | The PIN is stored only as a bcrypt hash; the **correct** PIN is refused while locked out; an admin can lift the lockout mid-event; no function returns a credential |
| law 7 | The wall's return type cannot name an original; a photo cannot become ready without a thumbnail |
| law 10 | An abandoned upload is swept; a late sync still lands; a dead worker's job is reclaimed; sweeps are visible |
| law 11 | Codes are 14 unambiguous base32 symbols; bulk guessing is refused; a real code from another client still resolves |
| law 12 | Every rate counter is a table, not a number in memory |
| feature D | The dollar cap refuses the call that would cross it |
| feature E | The publish gate is enforced by the database against a direct write; approvals are audited; the guest gallery hides unapproved photos |
| spine | Create event → operator logs in → capture → unapproved is absent from the wall → approve → it appears |

---

## Phase 1 — the airplane test

The database half of Phase 1 lives in `run_all_gates()` like everything else. The **device** half
cannot: no SQL can prove that a photo survives a browser losing its network, being power-cycled,
and coming back. That needs a real browser with a real IndexedDB, so it is a Playwright test.

**One line runs it:**

```
npm run gate:phase1          # short offline window, for the regression suite
npm run gate:phase1:full     # the contract's ten minutes offline
```

Both build their own bundle first. That is not tidiness — the first recorded run was silently
invalidated because `dist` was rebuilt against the production API while the test was reading it
from disk, so the gate now produces the artifact it tests rather than trusting whatever is there.

### What it does

1. Signs in and waits for the service worker to actually **control** the page — not merely be
   registered, because until it is, a reload still needs the network and the test would be
   measuring the wrong thing.
2. **Cuts the network** at the browser level.
3. Takes **ten shots in the dark**, and asserts all ten are on the device and none on the server.
4. Waits out the offline window, re-checking continuously that **the queue never shrinks**.
5. **Reloads the page mid-outage** — a station being power-cycled — and asserts nothing was lost.
6. Restores the network and asserts **exactly ten arrive, with zero duplicates**, the device queue
   drains to empty, and each photo kept the time its shutter fired rather than the time it landed.

A second test restarts the page **in the middle of syncing**, while the server is failing, and
asserts the invariant that matters: every shot is either still on the device or already on the
server — never neither.

### Why there is a mock server

This build session's network policy blocks the project's own domain, so the browser under test
cannot reach the real Edge Function. `mock-api.mjs` implements the same contract and nothing more
forgiving — registering a photo id that already exists is accepted and changes nothing, exactly as
`on conflict (id) do nothing` behaves in Postgres.

The split is deliberate and each half is proved where it lives:

- **The device half** — survives an outage, a restart, a retry; arrives exactly once — is proved
  here, in a browser, against a network that really goes away.
- **The server half** — that a replayed write cannot become a second photo — is proved by
  `gate_phase_1()` against the **real database**, which replays one write twenty times and one
  confirmation five times and asserts a single photo.

Neither half is asserted from the other's behaviour.
