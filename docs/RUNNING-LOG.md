# LAQTA v3 — running log

One entry per gate, in the contract's report format. Not approval requests: a record the owner
reads when he chooses. Every claim here was demonstrated, and the demonstration is named.

**How to re-run everything, any time, in one line:**

```sql
select * from run_all_gates();
```

The suite grows every phase and nothing in it is ever rewritten. A red row blocks the next phase.

---

# Phase 0 — Foundation · **GATE GREEN (44/44)**

## 1. What was built

**A — Events and setup.** Event manager with per-event branding, Arabic/English locale, and the
`draft → live → archived` status the feature list specifies, with a guard so nothing walks backwards.

**B — Auth.** Platform admin login, and per-event operator accounts with bcrypt PINs, a lockout that
cannot be outrun, and an admin unlock for when a stuck tablet locks a booth out mid-event.

**C — Capture.** Booth console: shoot or choose, per-shot restyle-or-straight-through, live feed,
device heartbeat with queue depth. The thumbnail is made on the device at capture time.

**D — AI foundations.** Per-event model list, generation count cap *and* a dollar ceiling consumed
before the paid call, cost columns, and a job lease so a slow worker is never charged twice.

**E — Moderation.** Approve, use-original, reject, hide, delete — all five, each one audited, with a
publish gate the database enforces against any caller.

**F — The wall.** Live grid of thumbnails that obeys freeze and panic, and holds its last good state
rather than going blank when a poll fails.

**G — Control room.** Five per-event switches that refuse work rather than hiding buttons, station
registry with online/offline and queue depth, and an ops summary that reports what telemetry dropped.

**H — Guests.** Three guest modes on the event, 14-symbol codes, gallery by code with downloads.

Plus: one Edge Function as the entire API surface, an installable PWA with a service worker, and a
224KB `dist` the owner drags into Cloudflare Pages.

## 2. The gate test, shown passing

`select * from run_all_gates()` → **44 passed, 0 failed.**

**The photo's journey, end to end:** create an event → an operator signs in with a bcrypt PIN →
a photo is captured with a thumbnail → it appears in the queue and is **absent from the wall** →
the operator approves it → **it appears on the wall**. Every step is a check in the suite.

**Each law attacked, not asserted:**

| What was done to it | What happened |
|---|---|
| 500 identical errors from one tablet | **1 row**, carrying a count of 500 |
| 50 different errors, cap of 10 | **11 rows** — the cap plus a marker — with **40** counted as dropped |
| Telemetry forced to fail mid-write | Caller **survived and committed**; the failure was still recorded |
| Every switch flipped on event A | Event B **untouched on all five** |
| Upload attempted while intake paused | **Refused** — while the identical call succeeded on the other event |
| The **correct** PIN, while locked out | **Refused** |
| Admin unlock, then the same PIN | **Accepted** |
| A direct database write setting `approved` on a non-ready photo | **Refused by the trigger** |
| A photo with no thumbnail, set to ready | **Refused by a constraint** |
| 35 guesses at a guest code, limit 30 | **Refused from attempt 31**; a real code from another client still resolved |
| An upload abandoned past its TTL, then synced late | Swept to `expired`, then **brought back to `ready`** |
| The sweeper run against a worker holding a live lease | Job **left alone**; reclaimed only once the lease lapsed |
| A retry re-sending a landed shot with different provenance | **Original provenance kept**, still one photo |
| Three $0.04 generations against a $0.10 ceiling | Third **refused before spending** |

## 3. Which ledger numbers died

**3, 5, 6, 7, 9, 10, 11, 12, 13 — dead, each with a permanent check in the suite.**

- **3** — a repeat cannot become a row; new kinds cost a finite per-device hourly allowance; the
  worst case is arithmetic, not vigilance.
- **5** — every switch, setting and counter is a column on an event row. A global toggle would have
  to be a column that is not on a row.
- **6** — bcrypt only, no function anywhere returns a credential, and the counter *is* the gate.
- **7** — `storage_path` is not in the wall's return type, and a photo cannot be ready without a
  thumbnail.
- **9** — the anon key can execute **nothing**; there is one API layer because there is no other way in.
- **10** — every transient state has a sweeper, sweeps are visible on quiet passes, and a late sync
  is rescued rather than destroyed.
- **11** — 32^14 keyspace with an unbiased generator, plus a database-backed lookup limit.
- **12** — every counter is a table.
- **13** — the suite exists, grows by appending, and re-runs in one line.

**1** has its foundation proven (a retry cannot duplicate, provenance cannot be rewritten) and dies
properly in Phase 1. **4** is hardened by the lease; its gate is Phase 3. **2, 8, 14** belong to
later phases.

**Two problems found that were not on the ledger.** The database granted the public key full rights
on every *new* table — shut, with an assertion that fails the gate if it reopens. And law 3
contradicted feature E, because overrides were being written into the table law 3 requires capping;
telemetry and the audit trail are now separate tables with opposite rules.

## 4. Regression line

All previous gates re-run: **44/44 green.** Nothing was skipped, weakened or deferred.

## 5. Deferred, and anything needing the owner's hands

`DEFERRED.md` is empty — nothing was cut and nothing was added.

Owner-hands items are being collected into one checklist at the end of the run. So far: the Anam
keys for the avatar kiosk (Phase 6 runs in its honest fallback until they arrive), and the final
dress rehearsal itself.

## 6. Next

Phase 1 — the offline engine. Device-first outbox on every capture surface, background sync with
infinite retry, queue depth surfaced to ops, and the wall's local cache and self-reconcile.

---

# Phase 1 — Offline engine · **GATE GREEN (53/53 + airplane test)**

## 1. What was built

**Device-first capture.** The shutter writes the photo — image bytes included — into IndexedDB
and returns. Nothing about taking a picture waits on a network, so a shot taken during an outage
is already safe before the first request is ever attempted. IndexedDB rather than localStorage for
the reason that decides the whole law: localStorage holds strings, and a queue that cannot hold
the image itself is not a queue, it is a note saying a photo used to exist.

**Background sync with infinite retry.** A record leaves the device only after the server confirms
it. Records are leased while sending, and a page that has just loaded reclaims every one of them
immediately rather than waiting out a lease belonging to a process that no longer exists. Attempts
are counted to show the operator what is happening, never to decide a photo may be discarded.

**Station heartbeats and queue depth.** Every booth reports how much it is still holding, so ops
sees a booth falling behind instead of guessing.

**Wall local cache and self-reconcile.** The wall keeps its last good set on disk, shows it after
a reload during an outage, and reconciles when the network returns.

## 2. The gate test, shown passing

**`npm run gate:phase1:full` — 2 passed (10.2m).** The recorded run spent **10.1 minutes offline**.

| Step | Result |
|---|---|
| Ten shots taken with the network cut | **10 on the device, 0 on the server** |
| Throughout 10.1 minutes offline, re-checked continuously | **the queue never shrank** |
| Page reloaded mid-outage — a station power-cycled | **still 10, still nothing on the server** |
| Network restored | **exactly 10 arrived** |
| Duplicates | **zero** |
| Device queue afterwards | **empty** |
| Each photo's shutter time vs arrival time | **shutter time kept** |
| Restart in the middle of syncing, server failing | every shot **either on the device or on the server — never neither**, then 10/10 with zero duplicates |

**Database half, `run_all_gates()` — 53/53.** One write replayed twenty times makes **one** photo;
one confirmation replayed five times is harmless; ten distinct shots stay ten. A station reports
its depth, shows offline within its per-event threshold, keeps its depth readable while offline,
and updates in place rather than multiplying when it returns.

## 3. Which ledger numbers died

**Law 1 — dead, demonstrated.** Not "we retry" but: the photo is on disk before anything is
attempted; nothing is deleted until the server has it; a crash mid-send is neither a loss nor a
duplicate, because every write is keyed on the client-minted id the record has carried since the
shutter fired; and retry never gives up.

## 4. Regression line

All previous gates re-run: **53/53 green**, plus both browser tests. Nothing skipped or weakened.

## 5. Three real defects this phase caught

Each would have reached the event.

**The PWA could not be deep-linked.** With a relative base, opening `/wall/<slug>` asked the host
for `/wall/assets/…`, received `index.html`, and the app never booted — and a refresh at `/booth`
404'd for the same reason. The wall screen would have been dead on arrival. The router is now
hash-based, so every station opens straight at its own URL on any static host with no rewrite rules.

**The service worker cached the document but not the bundles it references.** A station reloading
during an outage got a blank page — the precise moment the cache exists for. It now reads the asset
list out of the shell it is caching.

**A permanent failure looked exactly like a bad network.** A photo the device cannot encode fails
identically forever, and retrying it silently is how a shot goes missing with nobody noticing.
Failures the network cannot explain are counted separately and surfaced in the booth. Still never
discarded — just no longer silent.

## 6. Next

Phase 2 — the three walls: LED backdrop with configurable per-event layout, classic grid, and the
28-cell lightbox with persisted placement. Gate: each survives a hard refresh and a five-minute
network cut mid-show and resumes correct state alone, and unpublished photos are provably
unreachable.
