# Phase 0 — where the foundation actually stands

**Assessed:** 2026-08-28, against the live database `maranasi-laqta-v3` (`bdzdvlnmocojsifdkpvd`) and the seven
recovered migrations now in `supabase/migrations/`.

Method: every claim below was read out of the live database (`pg_get_functiondef`, `pg_constraint`,
`pg_default_acl`, `has_function_privilege`, `pg_policies`, `cron.job`, `storage.buckets`) or out of the recovered
SQL. Nothing here is inferred from a function's name.

---

## 1. Ledger status — the honest scoreboard

| # | Law | Status | The single most important reason |
|---|---|---|---|
| 1 | Internet death loses photos | **partial** | `photos.id` is a primary key with **no default** — the client mints it, so an upload retry cannot duplicate. But `ai_jobs.id` defaults server-side and `api_enqueue_job` is a bare insert, so a retried enqueue makes a second paid job. No outbox exists yet (Phase 1). |
| 2 | Background removal hangs | **alive** | No schema surface of any kind. Phase 3. |
| 3 | Telemetry floods itself | **alive** | `record_op` is an unconditional `insert` — no dedupe key, no sampling, no per-device cap, no retention. This is the 561k-row failure, reproduced exactly. |
| 4 | AI jobs killed mid-flight | **partial** | Real queue machinery exists (`claim_ai_job` with `for update skip locked`, attempts ceiling, `sweep_ai_jobs`). But there is no lease: `sweep_ai_jobs` re-queues anything `running` for 3 minutes, so a slow-but-alive worker gets its job stolen and the image is **paid for twice**. Timeouts are function arguments, not per-event rows. |
| 5 | Global flags hit every event | **partial** | No global settings table exists — good. But `ops_events.event_id` is nullable and `api_ops_summary` folds those null rows into **every** event's failure count; `claim_ai_job` has no event dimension at all; and twelve RPCs key on a bare row id with no event check, so an id from event B is operable while acting for event A. |
| 6 | Plaintext credentials | **partial** | Hashing and lockout are correct — bcrypt via `crypt()`, 8 failures in 5 minutes, and `verify_operator` returns an outcome rather than raising (raising would roll back the counter). But four functions `return setof operators`, and that composite type **includes `pin_hash`**. For a short PIN, handing out the hash is an offline-cracking target. |
| 7 | Walls serve originals | **alive** | `wall_photos` — the one function anon can call — returns `storage_path`, the original's path, alongside `thumb_path`. The wall is structurally *able* to reach originals. `thumb_path` is also nullable, so a photo with no thumbnail can still be approved and served. |
| 8 | Feature on with secrets missing | **alive** | No config or feature-readiness registry anywhere. |
| 9 | Duplicate API surfaces | **partial** | No duplicate surface exists — but no API layer exists either: **zero Edge Functions are deployed**, and every function except `wall_photos` is `service_role`-only, so a browser cannot reach the backend at all. Separately, the wall-eligibility rule is written out four times in four places. |
| 10 | Rows stuck in transient states | **partial** | `sweep_ai_jobs` covers `ai_jobs` and runs every minute. Nothing sweeps `photos` stuck in `processing`, and `operator_login_attempts` is never trimmed. The sweeper only writes to ops **when it changes something**, so a healthy sweeper and a dead one look identical. |
| 11 | Guessable guest codes | **alive** | There is no guest or guest-code table. Separately, `wall_photos` keys on `events.slug`, constrained to `^[a-z0-9-]{3,40}$` — a guessable namespace — and does not require the event to be `live`. |
| 12 | Rate limits forgotten on restart | **partial** | The login counter is a real table and survives restart. But it is the *only* limiter — nothing rate-limits guest lookups, uploads, telemetry or sends. |
| 13 | No tests | **alive** | Nothing executable in the repository. |
| 14 | Changes on event day | n/a | Phase 7. |

## 2. The landmine that is not on the ledger

`pg_default_acl` grants **`anon` full `arwdDxtm` on every new table created in schema `public`**, from both the
`postgres` and `supabase_admin` grantors. The six existing tables are safe only because RLS is enabled on each of
them with zero policies, which denies everything.

That means the entire security model currently rests on somebody remembering to type
`alter table … enable row level security` on every new table forever. Phase 0 adds roughly fifteen tables,
several holding guest PII. One forgotten line publishes them to anyone holding the public anon key.

`apply_function_grants()` has the same shape of hole: it filters `p.prokind = 'f'`, so procedures, aggregates and
window functions keep the default `anon` EXECUTE grant.

This must be closed structurally in the next migration — revoke the default privileges, and add a
`ddl_command_end` event trigger that force-enables RLS on any new table in `public`, so forgetting becomes
impossible rather than merely discouraged.

## 3. What the seven recovered migrations genuinely give us

A real spine, and better than its reputation:

- **Events, operators, photos, AI jobs and telemetry** as five event-scoped tables with sensible checks and
  partial indexes (`photos_wall_idx` is already `where approved = true and status = 'ready'`).
- **Correct bcrypt auth with a working lockout**, including the subtle detail that the verifier returns an
  outcome instead of raising, so the failure counter is not rolled back.
- **A working job queue** with `for update skip locked`, an attempts ceiling and a cron-driven sweeper.
- **A database-enforced publish gate**: the `photos_guard_approved` trigger fires `before insert or update` and
  refuses to let a photo be approved unless it is `ready`, and unless a generated photo has a completed job
  behind it. That holds against any caller, not just well-behaved ones.
- **An atomic spend guard**: `consume_generation` is one statement — `update … where generations_used <
  max_generations returning true` — so the budget cannot be raced.
- **Every function is `security definer` with a pinned `search_path`**, and the EXECUTE surface is minimal:
  35 of 36 functions are `service_role`-only.
- **Two private storage buckets** capped at 15 MB, image MIME types only.

## 4. The conflict that needs deciding, not coding

**Law 3 says telemetry must be capped, deduped and trimmed. Feature E says every admin override must be
logged.** Today both write to the same table: `approve_photo` and `unapprove_photo` call `record_op`, landing
audit records in `ops_events` beside ordinary telemetry.

Capping that table to satisfy law 3 would delete the audit trail. Keeping the audit trail forever leaves law 3
alive. The two requirements cannot both hold in one table.

**Resolution:** split them. `ops_events` becomes disposable telemetry — fingerprinted, counted, capped per
device, trimmed on a schedule. A new `audit_log` becomes append-only, event-scoped, never trimmed, with a typed
actor, action, target and before/after values. Overrides go only to `audit_log`. This is the design proposed for
migration 0008.

## 5. Where the existing schema must be changed rather than extended

Applied migrations are frozen, so each of these arrives as a **new** numbered migration:

- `wall_photos` must lose `storage_path` from its return type. A return-type change requires `drop function`
  then `create` — it cannot be done with `create or replace`.
- `ops_events.event_id` must become `not null`, and `api_ops_summary` must lose both `or event_id is null`
  branches.
- The four functions returning `setof operators` must be redefined with an explicit pin-free column list.
- The twelve id-only RPCs need an event argument and a matching predicate. The structural version of this fix is
  `unique (id, event_id)` on `photos` and `operators` plus composite foreign keys on `ai_jobs`, so a
  cross-event row simply cannot be referenced.
