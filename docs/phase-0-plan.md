# Phase 0 — plan, awaiting the owner's go

Per the contract: *"Plan gate first, every phase: before writing code for a phase, produce the short plan (what
files, what migrations, what the gate test will show) and get the owner's go."*

No Phase 0 code will be written until this is approved.

---

## The one decision that is the owner's, not mine

The database already holds seven applied migrations and a working spine, with **zero rows in every table**.

- **(a) Build on them.** Keep `0001`–`0007` frozen, add `0008`+ to close the gaps. Nothing is destroyed;
  reversible; work starts immediately. **Recommended.**
- **(b) Wipe and write one clean `0001`.** Matches the letter of the contract's Phase 0 wording and produces a
  tidier history, at the cost of a destructive reset — which the contract says needs an explicit yes.

Both reach the same end state. The gate judges the schema, not the file count.

## Migrations

Eight new numbered migrations, applied through the Supabase MCP. Grouped by what they kill:

| Migration | What it does | Kills |
|---|---|---|
| `0008_access_hardening` | Revoke the default `anon` grants on new tables and functions; event trigger that force-enables RLS on any new table in `public`; fix `apply_function_grants` to cover procedures; pin-free returns on the four operator functions; `wall_photos` rebuilt without `storage_path`; `thumb_path` required before approval; composite `(id, event_id)` keys so a cross-event row cannot be referenced | 6, 7, part of 5 |
| `0009_telemetry_audit_split` | `ops_events` gains a device id, a fingerprint with a unique constraint so repeats collide into a counter instead of accumulating, a per-device cap and a retention window; new append-only `audit_log` for every override, never trimmed | **3**, and the law 3 ÷ feature E conflict |
| `0010_event_settings` | Per-event branding, AR/EN locale, `draft → live → archived` with transition guards, guest mode, the five control switches (freeze wall, panic brand-only, pause intake, pause AI, banner), USD spend cap plus accumulated spend, allowed-model list, restyle templates and reference images | 5, 8 |
| `0011_guests_and_limits` | `guest_codes` with long high-entropy codes, `guests` with consent and retention, photo-to-guest grants, downloads, and a general `rate_limits` counter table used by guest lookups and every other limited path | **11**, 12 |
| `0012_capture_and_stations` | Station/device registry with heartbeat and queue depth; `photos` gains device id, client capture time, capture surface and the operator's per-shot restyle/straight-through intent; reject and delete states with reasons; idempotent job enqueue keyed on a client-minted id | 1, 10 |
| `0013_walls` | Wall/screen registry, per-event layout config, persisted 28-cell placement for the lightbox wall | 5 (F) |
| `0014_sweepers` | Sweepers for stuck photos, stale stations, old login attempts and telemetry retention; a lease and deadline on AI jobs so a slow worker is never double-charged; every sweep writes a heartbeat **even when it changes nothing** | **10**, 4 |
| `0015_api` | The RPC vocabulary the spine needs, all event-scoped | 9 |

## Files

- **`supabase/functions/api/`** — one Edge Function. The single API layer (law 9). It holds the service-role
  key, checks the operator session, and dispatches to the RPCs. Nothing else ever talks to the database.
- **`supabase/functions/_shared/`** — session verification, config health check (law 8), signed upload and
  signed thumbnail reads.
- **`src/`** — the Vite + React + TypeScript PWA. Phase 0 routes only: admin (create/edit event), booth
  (capture and upload), operator (approve queue), wall (grid). AR/EN with true RTL from the first screen — no
  hardcoded strings anywhere, because retrofitting that later is how it got skipped in v1.
- **`tests/gate/`** — the executable gate, described below.
- **`docs/phase-0-report.md`** — the report the owner receives.

## The gate test — what it will show

One command, living in the repository, re-runnable forever (law 13). It runs against the live database, creates
its own throwaway event, and cleans up after itself. It prints a pass/fail line per check:

**The walking spine** — create an event → an operator logs in with a bcrypt PIN → a photo is captured and
uploaded with a thumbnail → it appears unapproved in the queue and is *absent* from the wall → the operator
approves it → it appears on the wall. One photo's whole journey, end to end.

**Each law shown dead, by attacking it:**

- **3** — hammer the telemetry endpoint 5,000 times with the same error; assert the table gained a bounded
  number of rows and a counter went up instead.
- **5** — two events side by side; freeze the wall on one; assert the other is untouched. Repeated for every
  switch and counter.
- **6** — assert no function anywhere returns `pin_hash`; assert the account locks after 8 bad PINs and that
  the lockout survives a restart.
- **7** — assert the wall's response contains no path to an original; assert a photo without a thumbnail
  cannot be approved.
- **10** — plant a photo stuck in `processing` and an AI job stuck in `running`; run the sweepers; assert both
  are resolved and that ops shows the sweep even on a quiet pass.
- **11** — assert code entropy, then hammer a guest lookup and assert the database-backed limiter blocks it.
- **12** — assert every counter is a table, not memory.
- **plus** — assert zero tables in `public` lack RLS and zero carry an `anon` grant, then create a table on the
  fly to prove the event trigger enforces it.

**Also delivered:** the live table list, and a `dist/` build the owner can drag into Cloudflare Pages.

## What is deliberately not in Phase 0

The offline outbox (Phase 1), the three finished walls (Phase 2), the AI runner and background removal
(Phase 3), the control room screens (Phase 4), guest delivery (Phase 5) and the revived five (Phase 6). Phase 0
builds the **data model** those need, plus the thinnest spine that proves it works.
