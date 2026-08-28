# Law 3, shown dead

**Run against the live database on 2026-08-28, immediately after migration `0010` was applied.**

The test created a throwaway event, attacked it the way v1 was attacked, measured the result, and deleted
everything it made. It is reproduced as a permanent check in the phase gate.

## What was thrown at it

| Attack | Calls | What v1 would have written |
|---|---|---|
| One tablet repeating a single network error | 5,000 identical | 5,000 rows |
| A client inventing a brand-new error code every time | 200 distinct | 200 rows |
| Telemetry write against a non-existent event (forced failure) | 1 | crash the caller |

## What the database actually did

| Measure | Result |
|---|---|
| Rows written for the 5,000 identical errors | **1** |
| Occurrences preserved on that row (`n`) | **5,000** |
| Rows written for the 200 distinct errors | **51** — the cap of 50, plus one marker |
| Attempts counted (`ops_quota.rows_used`) | **200** |
| Kinds refused and counted (`ops_quota.dropped`) | **150** |
| Marker row's counter | **150** |
| Caller survived the forced telemetry failure | **yes** |
| That failure still recorded on the heartbeat | **yes** |

**5,200 hostile telemetry calls produced 52 rows.**

## Why it cannot be worked around

- A repeat cannot become a row. The unique key `(event_id, device_id, fingerprint, window_start)` means an
  identical error in the same hour can only increment a counter. Repeating forever costs zero rows.
- A new kind costs a slot, and the slots are finite. The per-device hourly allowance lives in `ops_quota`, in
  the database, so it survives a restart — law 12 — and it is keyed by event, so one event's broken tablet
  cannot spend another event's allowance — law 5.
- The ceiling is arithmetic. Worst case per device per hour is `cap + 1` rows. Nothing a client sends changes
  that number.
- Payload size is bounded too. Metadata over 2KB is replaced by its shape, so flooding by size is closed as
  well as flooding by count.

## The two rules the owner added

**A cap drops detail, never signal.** Going over the cap stops itemising new *kinds* of error. It never stops
reporting that the device is in trouble: `ops_quota.dropped` holds the exact number refused, and the reserved
marker row keeps counting. In the test, 150 kinds were dropped and both numbers read 150. A capped device is
loudly distinguishable from a quiet one, which is the opposite of silent truncation.

**Telemetry failure can never block the photo path.** `record_op` ends in an exception handler. In PL/pgSQL
that is a subtransaction, so anything that fails inside is rolled back to the savepoint and the caller's
transaction continues untouched. The test forced a foreign-key violation inside telemetry; the caller kept
running and committed, and the failure itself was still recorded on the sweeper heartbeat. Recording that a
photo arrived can never be the reason the photo does not.

## The conflict this resolved

Law 3 requires telemetry to be capped and trimmed. Feature E requires every admin override to be logged
forever. Both were writing to `ops_events`, so capping it would have deleted the audit trail.

They are now separate tables with opposite rules. `ops_events` is disposable: fingerprinted, collapsible,
capped per device, and trimmed on a schedule by `sweep_ops_events`. `audit_log` is append-only, carries a typed
actor and before/after values, and is deliberately absent from `sweep_ops_events` and from every other sweeper.
`log_override` is also, deliberately, **not** exception-safe — the opposite choice from `record_op` — because
losing an override record is not acceptable, so a failure to audit fails the override itself.
