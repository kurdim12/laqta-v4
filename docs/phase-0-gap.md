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

---

## 6. What the adversarial pass overturned

Three things the audit called structurally safe were attacked and did not survive. All three were re-checked
against the live database before being written down here.

**The pinned `search_path` is a snapshot, not an invariant.** Migration `0007` pinned `search_path` on all 36
functions, and all 36 are still pinned today. But `create or replace function` replaces a function's
configuration wholesale — omit the `set search_path` clause in a future migration and the pin is silently gone.
`pg_event_trigger` holds six rows, all Supabase stock, and **none of them inspects `pg_proc.proconfig`**
(verified: zero non-stock event triggers). So nothing prevents the next migration from un-pinning a
`security definer` function and reopening the escalation path. The gate must assert the pin, and an event
trigger should reject an unpinned `security definer` function outright.

**The minimal EXECUTE surface is also a snapshot.** It is minimal because `apply_function_grants()` was run once
by hand, over a faucet — `pg_default_acl` — that is still wide open for functions, tables *and* sequences, from
both the `postgres` and `supabase_admin` grantors. Every new object starts life granted to `anon`. This is the
same finding as section 2, arrived at independently, and it is the single most important structural fix in
`0008`.

**The lockout can be outrun, and cannot be lifted.** Two separate problems:

- *It is a check-then-act race.* `verify_operator` reads `select coalesce(sum(a.fails), 0) …` with a plain
  read — no `for update`, no advisory lock. A burst of concurrent attempts all read the same pre-threshold
  count and all proceed to test a PIN. Against a short numeric PIN that materially widens the window. The fix is
  to make the counter itself the gate — increment first and act on the returned value — rather than reading it
  and then deciding.
- *There is no way to unlock.* The only statement that clears `operator_login_attempts` sits inside
  `verify_operator` and runs **on successful login only** — which is precisely what a locked-out operator
  cannot do. The window is a rolling five minutes, so it does self-heal once failures stop; the earlier claim
  that it locks permanently is **wrong** and is not repeated here. The real hazard is operational: a
  misconfigured tablet retrying a wrong PIN every second holds a booth operator out for as long as it keeps
  retrying, in the middle of a live event, with no admin override. Phase 0 adds an admin unlock and a
  queryable "is this operator locked, and until when" so the control room can see and clear it.

---

## 7. Applied in 0008 and 0009 — verified

`assert_schema_locked()` returns **zero rows** against the live database, and both Supabase WARN-level
advisories about `wall_photos` being callable by `anon` are gone. What changed:

- The default-privilege faucet is **shut for the `postgres` grantor** — new tables, sequences and functions in
  `public` now grant only to `postgres` and `service_role`. Verified: `pg_default_acl` for `postgres` reads
  `{postgres, service_role}` on all three object types.
- **No function in `public` is callable by `anon` or `authenticated`** — the count is zero, `wall_photos`
  included. The anon key can no longer reach the database at all; every surface goes through the Edge Function
  API layer. That is law 9 taken literally.
- `wall_photos` returns `(id, kind, thumb_path, created_at)`. **`storage_path` is gone from the type**, so the
  wall cannot name an original even by mistake. Law 7 is dead for reads.
- A photo cannot be `ready` without a thumbnail, so nothing can be approved that would force a wall to fall
  back to an original.
- Nine constraints carry `event_id` into every foreign key on `photos` and `ai_jobs`, so a cross-event
  reference is refused by the database rather than by a function body.
- The four functions that returned `setof operators` no longer exist in that form; `pin_hash` is not in any
  return type, and setting a PIN returns nothing at all.

### The residual we cannot close, recorded honestly

`supabase_admin`'s default privileges in `public` still grant everything to `anon`, and `postgres` is not a
member of that role on a managed project, so no migration of ours can revoke them. This is inert for our
schema — every object we create is created by `postgres` — and `assert_schema_locked()`'s `anon_grant` check
reads actual table ACLs regardless of who created them, so an object arriving by that route is still caught.
It is written down here so it is never mistaken for something that was overlooked.

### A lesson that changed how migrations get written

`assert_schema_locked()` was created successfully by `0008` and then failed the moment it was called, because
the older migrations' `set check_function_bodies = off` meant its body was never parsed. A backstop that only
breaks when you call it reads as green until the day it matters. From `0009` onward, migrations leave body
checking **on**, and any migration that installs an invariant **calls it before finishing**, so applying the
migration is itself the proof.
