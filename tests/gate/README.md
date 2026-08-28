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
