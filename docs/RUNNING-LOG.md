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

---

# Phase 2 — Walls · **GATE GREEN (86/86 suite + full 5-minute cuts)**

## 1. What was built

All three walls (feature F), sharing one recovery discipline: hold the last good state in
memory and on disk, reconcile alone the moment the network or tab wakes, and never go blank in
front of a room.

- **Classic grid** — thumbnails only, hardened since Phase 0.
- **28-cell lightbox** — placement is a database table, not component memory: it survives
  refresh, power cut, and a second screen opening the same wall. One tick heals dead
  placements, autofills unless frozen, returns nothing under panic. Manual placement exists and
  is audited (its war-room UI arrives with Phase 4).
- **LED backdrop** — brand cells, photo cells with cycling, cutout cells; columns, rows, cycle
  speed and patterns are a per-event setting edited in the admin console. Nothing hardcoded to
  a venue.

Walls also stopped seeing the whole events row: `api_event_public` is the narrow shape an
unauthenticated screen may know, with AI prompt, budgets and spend **structurally absent from
its return type** — asserted by the gate.

## 2. The gate, shown passing

**Recorded full run: 3 passed (15.2m) — each wall held through a genuine 5-minute network cut:**
loaded mid-show → cut → never blank throughout (checked continuously) → power-cycled mid-cut and
came back showing the wall → reconciled alone on reconnect to the state the show had moved to.
The LED wall additionally proved its cycling and obeyed a panic flipped while it was dark.

**Database half (in `run_all_gates()`):** autofill places only publishable photos; an unapproved
photo leaves the wall **even while frozen** (the publish gate outranks the freeze); panic
empties and recovery is unassisted; a photo placed by hand occupies exactly one cell; another
event's photo **cannot** be placed on this wall (composite FK, not vigilance); layout
round-trips per event and never touches the other event.

## 3. Defect caught by the gate

`api_lightbox_place` failed at runtime: its OUT column shadowed a table column inside
`ON CONFLICT` — an ambiguity Postgres resolves only when the statement runs, so 0019 applied
cleanly and then failed under test. Fixed in 0020, which proves itself by running the entire
suite and raising on any red.

## 4. Decision recorded

Walls poll through the single API layer rather than opening anon Realtime reads — the stack
note and the anon lockdown were structurally incompatible; the lockdown won. Both options and
the reasoning: `docs/decisions/0002-polling-over-realtime.md`.

---

# Phase 3 — AI · **GATE GREEN (86/86, incl. the recorded 95-second run)**

## 1. What was built

**The job runner (law 4).** An Edge Function pg_cron pokes every minute through pg_net. The
poke is not the clock: the function answers in milliseconds and drains on its own time. The
lease from 0014 is the clock: the runner heartbeats while a model works, and its own abort
fires just inside the lease — bounded by OUR configured clock, never the platform's. The poke
is authenticated by a token that lives only in the database; nothing new for the owner to hold.

**Money (feature D).** The estimate is consumed BEFORE the paid call — count cap and dollar
cap in one atomic statement. Success settles the estimate against the model's real cost; every
failure refunds it. The admin console gained the per-event style prompt, model picker
(validated against the allowed list in the database — a typo cannot silently break event
night), budget, estimate and generation cap.

**Idempotent enqueue (laws 1 & 4 meeting).** A partial unique index converges a replayed
enqueue on the existing job, the same way a replayed upload converges on the existing photo. A
retrying outbox structurally cannot start a second paid generation.

**Self-hosted background removal (law 2).** The model — 44MB of weights plus the wasm
runtimes, 20 content-addressed chunks, every file ≤19MB — ships inside the deploy folder at
`./models/`. The booth warms it at sign-in with a real inference, cuts out after each capture
under a hard timeout (90s cold / 20s warm), and a missing/slow/broken model degrades to the
original silently. LED cutout cells render the figures; a photo without one renders contained.

## 2. The gate, shown passing

**The 90-second-class run, on the production runtime:** the runner held its clock for a
measured **95,006 ms** and completed — recorded permanently in ops, and the suite now asserts
that record forever. (v1's platform killed at ~20s.)

**Live drain, end to end through pg_net:** poke authenticated (bad token → 401), job claimed
under lease, cap consumed, then — the key discovery — failed terminally as
`AI_NOT_CONFIGURED`: **the OpenRouter key is not yet in the project's secrets**, the runner
runs in its honest law-8 fallback, and the reservation was refunded to the cent
(`used=1, spend=0`).

**Browser, real model:** a capture produced a real cutout from the shipped model with an
origin-lock proving **zero requests left our origin**; with the model directory deliberately
dead, the capture pipeline completed untouched, no cutout ever recorded, exactly one photo —
"use original", automatic and silent. 2 passed (30.5s).

**Deterministic suite:** replayed enqueue converges; failed photo may be re-enqueued; paused
event invisible to the drain and visible the moment the pause lifts; cap refuses the crossing
reservation BEFORE spend; settlement swaps estimates for reality (`spend = 0.021`, to the
tenth of a cent); a disallowed model is refused.

## 3. Which ledger numbers died

**Law 4 — dead**: queued jobs, no forced timeout (95s measured), runner owns its clock, lease
protects against double payment. **Law 2 — dead**: model ships with the app, hard timeout,
automatic use-original — proven in both directions in a real browser. The full paid-path
lights up the day the key lands; its absence today is the honest state law 8 requires, visible
in `ops.health`.

## 4. Regression line

`run_all_gates()`: **86/86.** Phases 0–2 re-passed inside the same call.

## 5. Debt and owner-hands, recorded

- Worker stores a generated image as its own thumbnail (display-sized, but unresized). A
  resize pass is owed before Phase 7 freeze.
- Event branding logo upload (feature A) not yet wired to a UI — owed before Phase 5 ends.
- **Owner-hands (end-of-run checklist):** paste the OpenRouter key into Supabase secrets
  (browser-only, ~2 min) to light up paid restyles; Anam keys likewise when avatar arrives.

## 6. Next

Phase 4 — control room and ops: the switches UI (already enforced server-side), live overview
on the sane telemetry, war-room with remote cell swap, station kill test (offline within 10s).

---

# Phase 4 — Control room & ops · **GATE GREEN (96/96 SQL + 4/4 browser)**

## 1. What was built

**The control room (feature G).** `#/control` polls the live overview every 2 seconds: the
five per-event switches as press-and-see buttons (freeze wall, panic brand-only, pause
intake, pause AI, banner with AR+EN text), the stations table with online/offline and each
device's queue depth, the AI spend meter against its budget, recent failures, the telemetry
cap's dropped count, sweeper heartbeats, and per-feature configured/missing pills from
`ops.health` (law 8 — the missing OpenRouter key shows as exactly that).

**The war room (feature G).** `#/war` shows the booth column and kiosk column side by side —
fed by the new moderation feed, which labels every photo with the surface that took it — a
28-cell wall mirror, and remote cell swap: tap a photo, tap a cell, and `lightbox.place`
moves it on the real wall. Approve lives inline, one tap.

**The kiosk (feature C).** `#/kiosk` is the guest-facing self-serve surface: an operator arms
it, guests get a square framing guide and a shutter, captures auto-crop to square (≤2048px),
land in the same outbox as the booth (law 1 applies untouched), and register with
`capture_source='kiosk'` so moderation and the war room can tell the surfaces apart.

**The data layer (migration 0023).** `api_moderation_feed` is an explicit column list —
thumbnails, cutouts, capture source, intent, latest job state; structurally no
`storage_path`, no credentials, deleted photos gone. The station offline threshold's default
dropped 30→8 seconds (still per-event, law 5), so a dead station is visibly dead inside the
gate's 10-second window.

## 2. The gate, shown passing

**Browser (4/4):** a fake station heartbeating every 2s is killed; the control room reads it
offline in a wall-clock-measured **≤10 seconds**, with its queue depth still on screen. A
switch flipped in the control room reaches a wall page that was never told (panic → brand
only → cleared → photos back). The war room reorders the wall with two taps — photo, cell,
and the mirror shows it placed. A kiosk shot lands in the approval queue unapproved and
labelled `kiosk`.

**Deterministic suite (96/96):** the ten new Phase 4 checks — offline threshold inside the
gate window, beating station online, 9-seconds-silent station offline with depth intact, law
5 re-proven through every switch at once (other event untouched), the switch flip in the
audit trail with its actor, the moderation feed's shape (capture source present;
storage_path and credentials absent from the return type), deleted photos leaving the feed,
and the ops summary carrying spend, telemetry and sweepers.

## 3. A law-1 regression found by the suite, and the fix

Re-running the Phase 1 gate (law 13's whole point) caught a real one: the post-confirm cutout
attempt ran INSIDE the drain loop, so ten photos taken dark confirmed one inference apart —
about 11 seconds each — when the network returned, and a mid-sync restart pushed the tenth
past the test's window. Enrichment was standing between photos and the server. The fix is
structural: after confirm (and the idempotent restyle enqueue), the outbox record is deleted
and the cutout attempt moves to a detached serial background chain. The photo path now owns
the drain loop alone; the airplane test dropped from 2.6 minutes to 43 seconds with the same
assertions. This is the ledger's rule restated in code: decoration never blocks the photo
path.

## 4. Regression line

`run_all_gates()`: **96/96** on the live database. Browser gates re-run after the fix:
phase 1 (2 passed), phase 2 (3 passed), phase 3 (2 passed), phase 4 (4 passed).

## 5. Debt and owner-hands, recorded

- Unchanged from Phase 3: worker thumbnail resize pass owed before freeze; branding logo
  upload UI owed before Phase 5 ends; OpenRouter key + Anam keys on the owner's
  end-of-run checklist.

## 6. Next

Phase 5 — guest modes & delivery: the three per-event guest modes (wall-only ·
code-per-shot · full registration), gallery by code with downloads, WhatsApp/SMS share.
Gate: each mode end to end on one event without touching another event's config.

---

# Phase 5 — Guest modes & delivery · **GATE GREEN (116/116 SQL + 4/4 browser)**

## 1. What was built

**The three guest modes, enforced where they cannot be bypassed (feature H, law 5).**
Migration 0025 turned `guest_mode` from a label into a shape: a photo-bound code can only
exist under `code_per_shot`, a guest-bound code only under `registration`, an unbound code
not at all, and a wall-only event can mint nothing — the database refuses, whatever any
client sends. Re-minting a shot returns its existing live code (one shot, one code), and
registration now consumes a per-client database-backed platform limit BEFORE writing
anything: laws 11 and 12 applied to the write side, not just the read side. Migration 0024
restated the Phase 0 gate first (its gate event now declares the mode its minting checks
always assumed — every check unchanged), because the enforcement rightly broke a gate that
predated modes; the failed first apply rolled back whole, which is the migration system
working.

**Code-per-shot at the booth.** In this mode every ready shot in the booth feed grows a
"Code" button; one tap shows a hand-over screen — the 14-symbol code, huge, plus a QR of the
gallery link — rendered entirely on the device by a bundled encoder, so the operator can hand
a guest their code while the venue's internet is down.

**Registration at the kiosk.** The kiosk leads with a bilingual form (name, optional phone,
explicit consent — recorded as a timestamp, with a retention date, not implied). The guest
registers once, then every shot they take binds to them AT THE SHUTTER: the guest id rides
the outbox, so a registered guest keeps collecting shots straight through an outage (law 1
untouched). The farewell screen hands over their code and QR; "next guest" holds nothing.
A guest can also register from their own phone at `#/g/<event>`.

**Gallery and delivery.** The gallery accepts `#/guest?code=…` so a scanned QR opens itself;
downloads sign the original for one object, one hour (the single place originals are ever
signed). Delivery is the sending path every guest already carries: WhatsApp and SMS share
links with the gallery URL prefilled, plus copy-link — nothing to configure, nothing that can
be unconfigured.

**Feature A closed out (migration 0026 + API v7).** The admin console gained the full
branding panel — bilingual names, default language, brand colors, logo upload through a
signed URL — and the lifecycle buttons (go live / archive). The public event shape now
carries the logo path so walls render the logo in brand cells and on the panic screen; the
printable QR kit lives at `#/qr/<event>` (guest / wall / kiosk QRs, print button). The gate
proves the lifecycle (nothing backwards from live, archived terminal) and re-proves that
widening the public shape leaked no AI config.

**One new dependency**, recorded: `qrcode` (MIT) renders QR codes locally to a canvas. It is
bundled — no network involved in showing a code.

## 2. The gate, shown passing

**Browser (4/4):** a wall-only event's guest page offers nothing to type; code-per-shot runs
its full journey (mint at booth → QR shown → guest types code → gallery with download →
WhatsApp/SMS hrefs carrying the gallery link); registration runs its full journey (kiosk
form → shot bound to the guest at the shutter, verified in the stored row → farewell code →
"next guest" resets → scanned deep link opens the gallery); three modes side by side serve
three different behaviours with zero leakage.

**Deterministic suite (116/116):** the twenty new checks — wall-only minting refused,
registration refused off-mode, unbound codes impossible, code alphabet correct, re-mint
converges, lookup resolves to its event and mode, gallery holds exactly the coded shot, the
publish gate holds even against a photo's own code, consent and retention recorded, capture
binding reaches the gallery, cross-event guest binding refused by the composite key,
registration rate-limited before anything is written, the branding/lifecycle checks — all
green, alongside every check from phases 0–4. Live production check: the demo event
(wall-only) answered `mode_refused` to a real registration attempt through the deployed API.

## 3. Which ledger numbers this touches

Law 11 now covers the unauthenticated WRITE side (registration charged before insert). Law 5
re-proven twice (mode isolation across events; cross-event guest binding refused by
construction). Law 1 extended through the guest binding (rides the outbox). The publish gate
(feature E) proven against guest codes. No law regressed: the full suite re-ran inside every
migration apply — 0025's first attempt was refused by exactly that mechanism.

## 4. Regression line

`run_all_gates()`: **116/116** on the live database. Browser gates re-run after every
frontend change: phase 1 (2), phase 2 (3), phase 3 (2), phase 4 (4), phase 5 (4) — all
passing.

## 5. Debt and owner-hands, recorded

- The branding-logo debt from Phase 3 is paid (panel, upload, wall rendering, gate).
- Still owed before freeze: the worker's generated-image thumbnail resize pass.
- Owner-hands checklist unchanged: OpenRouter key (paid restyles), Anam keys (avatar,
  Phase 6), the dress rehearsal.

## 6. Next

Phase 6 — the revived five: vogue editorial flow as a selectable style, shirt-picker kiosk
into the same approval queue, show cues + crew tasks UI in the control room, avatar kiosk
with its full degradation ladder (honest fallback until Anam keys — law 8), and guest
delivery is already live from this phase. Gate: each wired into the same approval queue and
flag system; avatar shows honest configured/missing state.

---

# Phase 6 — The revived five · **GATE GREEN (129/129 SQL + 4/4 browser)**

## 1. What was built

**Shirt-picker kiosk (feature I), into the one queue.** `#/shirt` shows the event's shirt
catalogue (per-event config, law 5, edited in the admin console as `id | English | Arabic`
lines and validated in the database — an option without an id is refused). The guest picks,
shoots, and the choice is written at the shutter as capture provenance on an ordinary photos
row. Same outbox, same approval queue, same restyle pipeline: the AI runner reads the
recorded choice and adds it to the event's style template, so the model styles what was
actually asked for; when AI is paused, capped or unconfigured, the branded original stands
exactly as it does for every other restyle. Migration 0027 makes a replayed capture unable to
rewrite the choice — proven in the suite.

**Avatar kiosk (feature I) with its full degradation ladder (law 8).** `#/avatar` asks the API
whether the avatar provider is configured, and never assumes: with no Anam key the top rung
answers `not_configured`, the kiosk shows the honest state in the staff corner and runs
welcome mode — branded bilingual greeting, working camera, same outbox, same queue, shots
labelled `avatar`. The ladder is re-climbed every minute, so **the day the owner pastes the
Anam key into Supabase secrets the live rung lights up with no deploy and no code change** —
demonstrated in the gate by flipping the key's existence and reloading.

**Show cues and crew tasks (feature I), inside the control room.** `#/control` grew both
panels: cues carry bilingual titles and a fire button that records the moment; tasks carry an
assignee and a done button that records the moment. Both are event-scoped rows (law 5 — the
gate proves a cross-event write matches nothing), and their activity flows through the capped,
deduped telemetry stream (law 3) rather than a second logging path.

**Vogue editorial flow (feature I), as a selectable style.** The grid wall reads
`wall_config.style`; `vogue` renders the same approved feed as a magazine spread — one hero
frame with a brand caption plate (the event's logo when it has one), a grayscale contact sheet
beside it. Selected per event from the admin console. It is a style of the same wall, not a
second wall: same feed, same publish gate, same self-recovery, same panic behaviour — the gate
proves panic still empties it.

**Guest delivery**, the fifth of the five, was finished in Phase 5 (gallery + WhatsApp/SMS
share) and stays gated there.

## 2. The gate, shown passing

**Browser (4/4):** the shirt picker refuses to show a shutter before a pick, then the shot
arrives labelled `shirt`, carrying `navy`, unapproved, queued for restyle, and the moderator
sees the choice on the tile in the queue. The avatar kiosk reads `fallback` with no key and
still lands a photo in the queue, then climbs to `live` on a reload once the key exists. A cue
typed in the control room fires and is recorded; a task is created and closed. The grid wall
switches from `classic` to `vogue` on its own poll and still goes brand-only under panic.

**Deterministic suite (129/129):** the thirteen new checks — the shirt shot is an ordinary
unapproved photo in the moderation feed, the feed carries the choice, a replayed capture
cannot rewrite it, an avatar shot lands in the same queue, the public shape offers the
catalogue while still hiding AI config, cues and tasks belong to one event alone, firing and
closing record their moments, the activity reaches the capped telemetry, a cross-event cue
write matches nothing, a catalogue with ids is accepted, one without an id is refused, and
the refused write changed nothing.

**A gate caught a real defect during this phase:** my restated `gate_cleanup` was written from
0015's version and had lost the `wall_cells` line a later migration added; the apply rolled
back whole on a foreign-key violation rather than landing a half-broken cleanup. Fixed by
restating from the live definition.

## 3. Which ledger numbers this touches

Law 8 gets its clearest demonstration: the avatar surface asks whether it is configured, says
so honestly, works anyway, and needs no deploy to change its answer. Law 5 re-proven for cues
and tasks. Law 3 extended to show-running activity. Law 1 extended again — the picker choice
rides the outbox and a retry cannot rewrite it. Law 9 held: five surfaces, zero new API
layers.

## 4. Regression line

`run_all_gates()`: **129/129** on the live database. Browser gates re-run after every change:
phase 1 (2), phase 2 (3), phase 3 (2), phase 4 (4), phase 5 (4), phase 6 (4) — **19/19**.

## 5. Debt and owner-hands, recorded

- Still owed before freeze: the worker's generated-image thumbnail resize pass.
- Owner-hands checklist: OpenRouter key (paid restyles), **Anam key (lights the avatar's live
  rung — the kiosk works without it today)**, the dress rehearsal itself.

## 6. Next

Phase 7 — rehearsal and freeze: the seed script (a demo event with operators, shirts, cues and
tasks, ready to run), the event-day checklist, the runbook, and the full regression. Then the
dress rehearsal — 30 minutes, internet pulled for 10 mid-run — which is the owner's to run,
and the hard freeze that follows it (law 14).

---

# Phase 7 — Rehearsal & freeze · **GATE GREEN (137/137 SQL + 20/20 browser)**

## 1. What was built

**The last debt paid (law 7, for generated photos).** The AI runner used to store a generated
image as its own thumbnail — a full-resolution file behind every wall, which is the exact
egress failure law 7 exists to kill. It now makes a real 512px thumbnail, and the proof is a
probe run on the production runtime and recorded where ops can read it: a 1600×1600 noise
source of **1,501,401 bytes became 348,076 bytes at exactly 512×512, in 97 ms**. Noise is the
worst case; a real photograph shrinks far more. The gate asserts that recorded probe forever,
the same way it asserts the 95-second run. A resize that fails costs quality, never the photo:
the original bytes stand in and the shot still publishes.

**The seed.** `seed_demo_event()` sets up a repeatable rehearsal in one call — a live,
code-per-shot event with three shirts, four cues, four crew tasks and one operator. It is
idempotent (verified: the second run created nothing, the counts held, the seeded operator
logs in), and the PIN is a parameter, so no credential lives in the schema or in any file.

**The paperwork that makes it runnable without me.** `docs/EVENT-DAY-CHECKLIST.md` (one page:
the night before, T-60, T-15, during, what to do when something goes wrong, after),
`docs/RUNBOOK.md` (deploy, station URLs, seeding, secrets, watching, diagnosing, repairing,
the gate suite, and what the freeze means), and `docs/OWNER-CHECKLIST.md` (the four things
that genuinely need the owner's hands, each browser-only and under two minutes).

## 2. A pre-freeze audit, and what it found

I went looking outside where the laws had been looking, and law 9's proof turned out narrower
than its claim. The check "the public anon key can execute nothing" counts routines in the
`public` schema — but `pg_net` (an HTTP request emitter, with a queue table anon holds every
privilege on) and `pg_cron` (the scheduler) live in their own schemas and grant EXECUTE to
`PUBLIC`, which every role inherits.

**What is actually reachable: nothing** — and that was measured, not assumed. A live request to
this project's own API carrying the real anon key, asking for a routine outside `public`, came
back `404 PGRST202 — "Searched for the function public.http_post ... no matches were found"`.
PostgREST resolves RPC only inside its exposed schema. The `cron` schema additionally denies
anon USAGE outright.

**What could not be fixed, said plainly:** those grants belong to `supabase_admin`, and this
project's `postgres` role is not a member of it. An earlier draft of the migration tried to
revoke them; its own pre-commit assertion caught that the revoke had silently changed nothing
and rolled the whole migration back rather than let me claim a fix that had not happened. The
residual is a platform default. The mitigation that IS ours is now a freeze invariant in the
runbook: **the exposed-schema list stays `public`** — adding `net` or `cron` to it would hand
anyone holding the public anon key an HTTP emitter and a job scheduler.

Migration 0030 turns all of that into permanent checks: the recorded live probe is asserted on
every gate run, and the schema-lock assertion gained a rule we can hold — no hand-written
routine of ours ever lives outside `public` (extension members excluded by their dependency,
because pgcrypto in `extensions` is a deliberate, pinned install, not a stray function).

## 3. The dress rehearsal, and what the first run caught

The rehearsal is executable: a single continuous session that starts a show, kills its
internet mid-run for the contract's full ten minutes, and checks what the contract asks —
zero photos lost, walls recovering alone, ops telling the truth throughout, one logged
override.

**The first full-window run failed, and it was the gate's own bug.** It hung for its entire
twenty-minute ceiling on one line: the control room's cue field never appeared, because the
spec navigated to `#/control` immediately after clicking sign-in without waiting for the
session to exist, so the page bounced back to the login screen. The short run had been winning
that race; the long one lost it. Fixed by waiting for the session to be real before anything
navigates, and by bounding the first assertion so a control room that never renders fails in
seconds instead of eating the whole budget. Worth recording plainly: a gate that hangs is a
gate that tells you nothing, and this one was hiding a race rather than proving a product.

**The recorded run: 10.3 minutes, green.** In one continuous session, on the real build:

1. The show starts — a cue on the board, four shots taken, approved, reaching the wall the
   room can see.
2. The internet dies. Six more shots are taken dark; all six sit on the device, none reach the
   server, and the wall — never told anything — keeps showing the room what it had.
3. Ops tells the truth while it is dark: the booth reads offline in the control room, which is
   on its own connection, exactly as it would be on a hotspot at a real event.
4. Ten minutes pass. The queue never shrinks, not once, checked every five seconds throughout.
   The station is power-cycled mid-outage and still holds all six.
5. The internet returns. **All ten photos arrive — four from before, six from the dark — and
   not one of them twice.** The device queue drains to empty.
6. An override is made and takes effect.
7. The wall catches up on its own: no refresh, no human, nobody touching the screen. The show
   board still holds what the control room put there.

## 4. Regression line

`run_all_gates()`: **137/137** on the live database, across all seven phases. Browser gates,
every one re-run after the last change: phase 1 (2), phase 2 (3), phase 3 (2), phase 4 (4),
phase 5 (4), phase 6 (4), phase 7 (1) — **20/20**.

## 5. What was added to the stack during the run, recorded

Two dependencies, both free, both bundled rather than fetched at runtime:

- `qrcode` (MIT) — draws guest codes locally, so an operator can hand a guest their code while
  the venue's internet is down.
- `imagescript` (via the AI runner) — makes the generated-image thumbnail that law 7 requires.

## 6. Where the ledger stands

All fourteen laws are dead by design and demonstrably so, each with a permanent executable
check that re-runs before every future change. Law 14 — the freeze — is the one that cannot be
closed from here: it is triggered by the owner's own rehearsal on real hardware in a real
venue, which is item 4 on his checklist. Everything is ready for it.

## 7. Owner-hands, the complete and final list

`docs/OWNER-CHECKLIST.md`, four items, all browser-only:

1. Put the app on a web address (drag-and-drop, ~2 min).
2. Paste the OpenRouter key into Supabase secrets — turns on paid restyles (~2 min).
3. Paste the Anam key — lights the avatar kiosk's live host (~2 min).
4. Run the dress rehearsal on real hardware, then the freeze (30 min).

Nothing in this build waits on any of them. Items 2 and 3 light up extra capability; without
them those features run in honest, designed fallback, which is what law 8 asks for.

---

# Post-freeze audit — **three blockers found, two fixed, one waiting on the owner**

Before declaring the build finished, eight independent audits ran over the repo and the live
database — scope against the approved feature list, the 14 laws, test coverage,
never-run-in-production paths, code correctness, bilingual/RTL compliance, deployment drift,
and whether the documents tell the truth — with every claimed gap adversarially verified by a
separate reviewer. 125 findings were raised; 116 survived verification. Nine were refuted or
already handled.

## What the audit found that the gate suite could not

**Law 6 had a hole its own checks were shaped not to see.** Migration 0029 gave
`seed_demo_event` a parameter default of `'2468'` — a constant credential, in a public
repository, readable from `pg_proc`, and the live PIN on both live events. The two law-6
checks passed throughout because they asked "is it stored as a bcrypt hash" and "does any
function return a credential". Neither asked whether one is *readable*. This is the second
time this shape has appeared (law 9's anon check counted only the `public` schema), and it is
worth naming as a pattern: **a check that tests the mechanism you built will not find the
mechanism you forgot.**

Worse, nothing could repair it. `api_set_operator_pin` and `api_set_admin_password` have
existed since 0008 and 0011 and were reachable from no API action and no UI, and there was no
way to deactivate an operator at all. A PIN that leaked at 21:00 worked for the rest of the
event, permanently.

**Every browser gate runs against a mock.** All 20, phases 1 through 7 including the dress
rehearsal, drive `tests/gate/phase-1/mock-api.mjs` rather than the deployed backend. This is
disclosed in `tests/gate/README.md`, `RUNBOOK.md` and `docs/api-layer.md` — and nowhere in
this log, whose phase reports read as though they were observed on real infrastructure. They
were not. Recording that correction here.

**`storage.objects` is empty, and always has been.** `n_tup_ins = 0` over the project's whole
history. `signedUploadUrl`, the device PUT and the worker's upload have run zero times in
production: every photo passes through ~20 lines of plumbing nothing has ever executed.

**The regression suite rewrote the deliverable.** Every `gate:phaseN` ran `build:test`, which
wrote to the same `dist/` with the API pointed at `localhost:8787`. `dist/` was correct only
because a production build happened to run last.

## What was fixed in this pass

**Migration 0031 (applied, self-verified, file byte-identical to the applied statement).**
The seed mints a random six-digit PIN when none is supplied and returns it exactly once
instead of publishing a constant. Every bcrypt mint site moves from pgcrypto's default cost 6
to cost 10 (existing hashes keep verifying — bcrypt carries its cost). `api_set_operator_pin`
gains an admin actor, a minimum length, and an audit record that never contains the new
credential. `api_set_operator_active` is new, and real: `verify_operator` has required
`active = true` since 0011. `log_override_admin` finally lets `actor_kind = 'admin'` be
written, which `audit_log` has allowed since 0010 and nothing could produce.

`gate_credentials()` adds 15 checks asking the four questions the original two did not: is a
credential *readable*, *rotatable*, *revocable*, and *strong enough*. Two of them are the
generalised form of this specific defect — no function in `public` may carry a parameter
default feeding a pin/password/secret/token argument, and the seed's signature must show
`p_pin DEFAULT NULL`.

**API v9 and the admin console.** `operator.setPin` and `operator.setActive`, admin-only, and
Change PIN / Deactivate buttons beside the existing Unlock. Verified on the deployed function
through pg_net: an unauthenticated call answers `403 ADMIN_ONLY`, not `404 UNKNOWN_ACTION`.

**The dist trap.** `build:test` writes to `dist-test`, the gates' static server serves from
there, and both are gitignored. Verified: after a full seven-phase regression run, `dist/`
was untouched and `dist-test/` was new. The four-phase-stale zips in the repo root are gone.

**Two migrations that refused to land.** 0031's first attempt tried to give
`api_create_operator` a `setof operators` return — which would have put `pin_hash` back into a
return type, the exact thing law 6 forbids. Postgres rejected the return-type change before
the gate ever ran. The second attempt hit the OUT-parameter shadowing that 0020 fixed once
before. Both rolled back whole. Recording them because the value of transactional migrations
that run their own suite is precisely that they catch the author.

## Regression line

`run_all_gates()`: **152/152** on the live database. Browser gates: **20/20**, all seven
phases, re-run after every change in this pass.

## Still open, and honest about it

- **Both live operators still have the published PIN.** The structural fix landed; the live
  credential has not been rotated, because those are the credentials the owner was given and
  changing them silently would lock him out. One tap in the admin console now does it, or one
  word to me. Until then the exposure stands: the repo is public and the PIN is in its history
  permanently.
- **The storage path is still unexercised.** Container egress to the project domain is
  blocked, so this cannot be closed from here; it needs one real end-to-end shot on the
  deployed stack.
- Roughly nineteen should-fix findings remain (signed-URL churn on every wall poll, stale
  queue-depth closures on three kiosks, four moderation verbs missing an event predicate, no
  dollar cap on either live event, registration throttling at ~2 guests/minute, the admin
  being unable to moderate at all). None is a blocker; all are recorded.

---

# Relay: rotate, prepare the real-infra gate, triage — **166/166 SQL · 20/20 client-logic**

## 0. The finish line moved, and the log is relabelled to match

No freeze on mock evidence. Every recorded browser run in the entries above is hereby
**relabelled a client-logic proof**: all 20 drive `tests/gate/phase-1/mock-api.mjs`, including
the Phase 7 dress rehearsal. They prove the outbox never loses a photo, that walls recover
alone, that a switch reaches a wall that was never told — real properties of the client, none of
them a proof about the deployed backend. Every spec file now says so in its first four lines,
and `tests/gate/README.md` carries the two-suite table. The 166 SQL checks are unaffected: they
run directly on the live database and always have.

## 1. Rotation — done, and one item I could not do

Both live operator PINs are rotated through the new path, with fresh randomly-minted
credentials, and verified end to end: **0 operators authenticate with the published PIN**, both
new PINs return `ok`, the old one returns `bad_credentials`, the new hashes are `$2a$10$`, and
both changes are in `audit_log` as `actor_kind = 'admin'`.

**The repo is still public.** There is no MCP tool for repository visibility and no `gh` CLI in
this container, so this is the one part of the instruction I cannot execute. It is 30 seconds in
a browser: GitHub → the repo → Settings → scroll to Danger Zone → Change visibility → Make
private. Worth doing regardless of the rotation, because the old PIN remains in the git history
permanently.

## 2. The storage gate, made diagnosable

The owner's first end-to-end shot is the gate. `docs/STORAGE-GATE.md` is his four-step page.
What was built so that a failure is legible rather than mysterious:

- **`#/diag`** — reads the device's own IndexedDB queue, so it tells the truth during an outage,
  which is exactly when it is needed: device id, online state, per-feature configured/missing,
  and the exact last error per stuck photo, with a Copy button. It is read-only, so handing an
  unlocked tablet to a bystander on that screen is safe.
- **The three kiosks stop swallowing failures.** `catch { setState("idle") }` on Kiosk, Shirt and
  Avatar returned an unattended tablet to "tap to shoot" after eating a shot — the exact way a
  guest walks away believing they were photographed. Each now shows a bilingual message and
  reports the failure.
- **The outbox reports what the network cannot explain.** A second consecutive hard failure
  sends one capped, deduped `ops.report`, so a photo stuck on a tablet in Amman is visible on
  the control room screen. Fire-and-forget: law 3 says telemetry may never block the photo path,
  so nothing awaits it.

**Two defects fixed pre-emptively, because they would have failed this gate for the wrong
reason.** Both were in the audit and both are on the exact path the owner is about to walk:
iPhone HEIC captures would have been refused forever by a JPEG/PNG/WebP bucket (every capture is
now re-encoded at the shutter), and Supabase Storage reports a duplicate object as HTTP 400 with
`{"statusCode":"409"}` rather than HTTP 409, which would have turned a successful retry into a
permanent failure inside an infinite-retry loop (both shapes now read as success).

## 3. Triage, in event-kill order — migration 0032

- **Dollar caps.** `ai_budget_usd` was nullable, `api_create_event` never set it, and both live
  events had NULL: every event ever created shipped with no dollar ceiling, only a count cap.
  The column is now NOT NULL with a default; existing nulls were backfilled from what the count
  cap already implied. Both live events now read **$25.00**.
- **Admin moderation.** Feature E promises "admin sees all, overrides anything, every override
  logged". Every moderation verb required an operator and threw 403 for an admin. All seven now
  accept either actor, `approved_by` stays null for an admin (the audit trail is where their
  name belongs), and the override is attributed to them by name. `#/queue?event=<id>` is reachable
  from the admin console, and `photo.unhide` — which existed in the database and was exposed
  nowhere — is now an action, so hide stops being a one-way door.
- **Event predicates.** `unapprove`, `hide`, `reject` and `delete` selected `from photos where
  id = ...` with no event predicate. One `moderation_scope()` now governs all seven verbs: an
  operator is confined to their own event, an admin is not, and a deactivated operator is
  neither. Law 5 holds in the database rather than in the caller.
- **Registration throttle.** The limit is charged per client, and a kiosk is one client for every
  guest who uses it — so ten per five minutes throttled a whole station to two guests a minute.
  Raised to 60. The gate proves thirty succeed and that a ceiling still exists above them.

Fourteen new checks. `run_all_gates()`: **166/166**, file byte-identical to the applied statement.

## 4. Repointing the gates at the deployed backend — not feasible here, with evidence

```
$ curl https://<project>.supabase.co/functions/v1/api
curl: (56) CONNECT tunnel failed, response 403
```

The container's network policy refuses CONNECT to the project domain, so Playwright inside it
cannot drive the deployed backend either. That is a policy and it is not worked around. The
feasible half was done instead: every gate is labelled with what it actually drives, and
`tests/gate/README.md` records that repointing is one variable (`VITE_API_URL` in `build:test`)
for whoever runs this suite somewhere with egress — along with the instruction to relabel only
the gates that actually change, and leave the rest honestly marked.

## Still open

- The repo is public (owner, 30 seconds, above).
- The storage round trip is unproven until the owner's shot.
- The remaining should-fix items, unchanged: signed-URL churn on every wall poll, stale
  queue-depth closures on three kiosks, the 12-hour session with no client handling, the AI
  refund-after-paid-call path, and the bilingual pass.

---

# Relay: wall polling · **175/175 SQL · 20/20 client-logic · the storage gate is CLOSED**

The headline is not the item I was asked to do. It is what doing it found.

## The storage round trip has now run in production, and it was broken

Gate 1 needed a real object in a real bucket to prove a signed URL is stable. Nothing could
make one: the build machine's proxy refuses CONNECT to the project domain. But the API function
holds the service key and *can* reach storage — so it now tests itself. `ops.selfTest` uploads a
real PNG, signs a read, fetches it back, compares bytes, re-signs to prove URL stability,
re-uploads to exercise the retry path, deletes what it made, and records the result whether it
passed or failed. It is authenticated by a worker token like the AI poke, so pg_cron and the
gate suite can trigger it with **no human credential in existence**.

**The first run failed**, at the first step, with `UPLOAD_URL_FAILED`. The second run — after
reading what the logs actually showed rather than what the error said — revealed the shape:

> **Signing an upload URL for an object that already exists is refused by Supabase Storage.**

That is not an edge case. It is the retry path. The outbox re-asks for upload URLs on every
retry, so a photo whose bytes landed but whose `register` call failed would be refused *at the
signing step*, forever, inside an infinite-retry loop — a lost photo wearing the costume of
patience. And the tolerance I had added the day before was one layer too low: it was on the
PUT, and the failure is on the SIGN.

Fixed with `x-upsert`. The recorded production run now reads:

```
uploadStatus 200 · urlStable true · readStatus 200 · bytesMatch true
duplicateStatus 200 · deleted true · 1273ms
```

Those are the first bytes ever to move through Supabase Storage in this project's history.
`gate_storage()` asserts all of it permanently, and `poke_selftest` re-runs it hourly — with a
staleness check that fails if the proof ever goes older than seven days, because three of this
suite's existing checks assert frozen historical probes that can never fail again, and I did
not want to add a fourth.

## Gate 1: wall polling

A signed URL is a JWT carrying its own issued-at, so signing the same object twice yields two
different strings — and the query string is part of the HTTP cache key. Every wall poll was
handing the browser a brand-new URL for a thumbnail it was already showing, and the browser
re-downloaded all of them, every few seconds, on the venue uplink whose death is ledger item 1.

Signed URLs are now cached by `(bucket, path, lifetime)` and the same string returned while it
is young. **Proven on the deployed function, not a mock**: two consecutive signings of the same
object return byte-identical strings (`urlStable: true`, recorded). Reuse is 3000s against a
3600s signature — a ten-minute margin, so a URL is retired well before it could die in a
viewer's hands, and `ops.health` now reports the numbers so that margin is assertable rather
than merely intended. Cache is bounded at 5000 entries, oldest-first eviction.

## The gate suite was hiding a check from itself

`gate_storage()` returned `pass = null` for the duplicate check that never ran — and
`count(*) where not pass` does not count a null. **A check with no verdict silently vanished
from the failure count instead of failing.** Every gate here is written the same way, so the
hole existed anywhere a check might produce a null.

`run_all_gates()` now coerces every verdict to false when null, and `gate_suite_integrity()`
asserts that no check returns a null verdict and that every check names both what it expected
and what it found. This is the third time this suite has been narrower than its own claim — law
9 counted only one schema, law 6 asked "is it hashed" but not "is it readable" — and the shape
is identical each time: **the check tested what was built, not what was missed.**

The first attempt at that migration made the integrity check a member of the union it queries.
It recursed until the migration timed out, and the transaction rolled the whole thing back
rather than leaving half of it applied. Split into `run_gate_checks()` (every gate) and
`run_all_gates()` (that, plus the suite's check on itself).

## Regression

`run_all_gates()`: **175/175**, zero null verdicts. Browser gates **20/20**. Migrations 0033
and 0034 byte-identical to their applied statements.

## Gates 2, 3 and 4 are not done

Queue depth, sessions and AI refunds are untouched this pass. Gate 1 turned into a production
defect hunt and I followed it rather than leaving a broken storage path behind a green board.
Next.

---

# Log entry — outcome gates 1 (closed), 2, 3 and 4

The three additions the architect asked for, then the three remaining gates. All four outcome
gates are now built, and each was **falsified before it was believed**: the fix reverted, the
gate watched going red, the fix put back.

## (a) The rollover, recorded

Gate 1's last clause — "expiry rollover proven mid-show" — is a property of elapsed time, not
of a single request, and the moment it matters is an hour into a show with nobody watching.
Asserting it at the production TTL would mean a fifty-minute request.

`ops.selfTest` grew an opt-in probe: it signs with a lifetime whose reuse window is ten
seconds, waits past it in real time, signs again, and fetches what comes back. Same code path,
same arithmetic; only the clock is compressed. Run once on the live project:

```
rolloverTtlSeconds 610 · rolloverReuseSeconds 10 · rolloverWaitMs 12000
rolloverMintedNew true · rolloverStillWorks true · rolloverReadStatus 200 · elapsedMs 13148
```

A new URL was minted after the reuse window elapsed, and it fetched the object. `gate_storage()`
asserts it and is **non-blocking when no rollover run exists** — a gate that goes red because
an optional probe was skipped teaches people to ignore red, which is how a suite stops being a
suite.

## (b) and (c) Where the verdict lives, and who reads it first

The event-day checklist now **opens** with it, before the night-before section:

> **Control room → Config health.** The **storage** pill reads green and the line under it says
> the photo round trip was proven minutes ago, not days.

That pill used to mean "a URL is configured" — which is true on a project where not one byte
had ever moved through a bucket. It now carries the round trip's real verdict, which is what
law 8 actually asks of a surface. Nothing to press: the probe is poked hourly.

**The verdict's address, for the architect to read directly:**

```sql
select ran_at, detail
  from sweeper_runs
 where sweeper = 'storage_selftest_probe'
 order by ran_at desc
 limit 1;
```

`detail` is jsonb: `uploadStatus`, `urlStable`, `readStatus`, `bytesMatch`, `duplicateStatus`,
`deleted`, `elapsedMs`, the deployed function's own `sessionHours` / `sessionRefreshAfter`, and
the `rollover*` keys on a run that asked for them. Recorded whether it passed or failed.
`RUNBOOK.md §5b` documents this, and `api_storage_verdict()` is what the control room reads.

## Gate 2 — queue-depth truth

**The bug.** Every kiosk surface read its queue depth out of a React state variable captured
when the heartbeat interval was created. The closure held the depth at mount — zero — forever.
A kiosk holding forty photos told ops "0 waiting", cheerfully, every ten seconds. The screen
was right and the wire was wrong, which is the worst arrangement: the person standing at the
kiosk can see the truth and the person who has to act on it cannot.

**The second bug, quieter.** The control room rendered an offline station's depth as a bare
number. A dead station's depth is the last thing it managed to say, not what it is holding now
— and "0" is the most dangerous of those, because it reads as "nothing waiting" when the truth
is that nobody knows. An offline row now dates its number.

The gate shoots six photos with the kiosk's photo path dead and its heartbeat alive (the mock
grew a scoped outage for exactly that case — one station's uploads stuck on a weak uplink while
ops, on its own connection, sees everything). It asserts the depth **on the wire**, then kills
the tablet and asserts ops shows offline, still six, and dated; then revives the same browser
context and watches the number follow reality back to zero with the qualifier gone.

Falsified: with the closure reinstated, the gate reports `Expected 6, Received 0`.

## Gate 3 — session survival

Twelve-hour sessions. Stations are set up the evening before an event and expected to work
through the following night unattended; twelve hours expires them somewhere around the second
guest — and because the expiry lands mid-shoot, it lands on a device already holding photos.

- **36 hours, with sliding refresh.** Length alone would be the lazy fix: a long-lived token is
  a long-lived credential. Past halfway, any call returns a fresh token in an `x-laqta-session`
  header the client adopts, so a station in use never expires under the person using it while a
  tablet closed for two days still does.
- **Expiry cannot strand the outbox.** `NOT_SIGNED_IN` is transient: the drain loop stops
  instead of burning retries against a wall, nothing is marked permanently failed, and the
  booth shows a distinct banner asking for the one thing a person can fix in ten seconds.

Three places had to be right for the refresh to work — sent, exposed by CORS, adopted — and the
mock was wrong in the second one, which is exactly why it is worth having a test that fails.

**The deployed constant is asserted against production, not the mock.** A constant inside a
deployed function is precisely the kind of thing that quietly reverts, and the browser suite
runs against a stand-in, so it can only prove the client adopts what it is given. The function
now reports its own `sessionHours` and `sessionRefreshAfter` into `sweeper_runs` on every
hourly self-test, and `gate_sessions()` reads it. Redeploy a twelve-hour session and the suite
goes red within the hour.

Falsified both halves: without the header adoption the refresh gate fails; without
`NOT_SIGNED_IN` as transient the booth never shows the banner.

## Gate 4 — refund reconciliation

Two things were wrong, and both read as prudence.

**The refund was a lie on one side.** The worker's catch refunded the reservation to zero for
every failure. But the paid call sits in the middle of that try block: if the model returned
bytes — and charged us — and the storage upload or the insert then failed, the money is real
and the meter forgot it. An event could spend past a budget the cap was still cheerfully
enforcing against a number nobody was paying.

**A refunded generation stayed spent.** `consume_generation` increments `generations_used`;
`settle_generation` only ever touched dollars. A transient failure gave the money back and kept
the generation, so three retries of one photo burned three of an event's N and produced nothing.

The fix is not "remember to pass the right number". The reservation now lives **on the job**,
so the books can be checked rather than trusted:

```
events.ai_spend_usd     == sum(ai_jobs.spent_usd) + sum(ai_jobs.reserved_usd)
events.generations_used == sum(ai_jobs.generations_charged) + count(reserved)
```

The meter equals what we have paid plus what we have promised — true at every instant,
including mid-generation with a job in flight, and asserted **against every real event** on
every gate run. A worker deploy that settles the old way never stamps a reservation at all, so
the invariant breaks on its first real job rather than at the end of an event when the number
is already wrong and the money already gone.

`settle_job`'s `p_used_generation` has no default: the caller is forced to say which side of
the paid call it failed on. "Refund everything on any failure" is the shape that hid this.

Falsified: the old behaviour reinstated inside a transaction turns **8 checks red**, the
headline one reading `a failure after the model was paid books the real cost — expected
0.0375, actual 0.0000`. Rolled back; green again.

**And the deployed worker was run, not merely read.** ai-worker v5 was deployed and poked
against the live project with a real queued job: it claimed the job, took a real reservation,
hit the unconfigured branch, released it and refunded the generation. Both invariants held,
`reserved_usd` back to null, spend back to 0.0000.

## Regression

| Suite | Result |
|---|---|
| `run_all_gates()` on the live database | **196/196** |
| Browser gates (phases 1–7 + outcome) | **24/24** |
| Migrations 0035, 0036, 0037 | byte-identical to their applied statements |

Phase 4's station assertion needed updating: it asserted the bare depth text, which is now the
*less* honest render. It reads the attribute and the staleness marker instead.

Migration 0036 is the one migration since 0009 that did **not** self-verify, deliberately and
in order: `gate_sessions()` is red until the deployed function reports its constants, so the
sequence was migration → deploy → self-test → green. It was confirmed that exactly those three
checks were red in between and nothing else.

## Still open

- **The OpenRouter key is not in Supabase secrets** (`ops.health` reads `openrouter: false`).
  The system degrades honestly and this was just proven end to end on the live project — the
  job fails `AI_NOT_CONFIGURED`, the reservation and the generation are both refunded, and the
  operator publishes the original. No restyling happens until the key is pasted in. **Owner's
  browser**, under two minutes: Supabase dashboard → Project Settings → Edge Functions →
  Secrets → add `OPENROUTER_API_KEY`. No deploy needed; the worker reads it per invocation.
- **The repository is still public.** Owner's browser: GitHub → repo → Settings → Danger Zone →
  Change visibility → Private.
- **Repo↔deploy byte-equality for the Edge Functions is not machine-checked.** This container
  cannot reach `api.supabase.com`, so deploys go through the MCP tool with inline content that
  I transcribe from the repo file. The changed surfaces were verified *behaviourally* against
  the deployed functions — `ops.health`'s new fields, `ops.selfTest`'s full report including
  the rollover, and the worker's whole money path — but a diff between the repo file and what
  production is running is not something this environment can compute. Stating it rather than
  implying a check that does not exist.

---

# Log entry — the should-fix list, in event-impact order

Five items, worked by what breaks a show rather than by what is quickest. Every fix carries an
executable gate, and every gate was falsified before it was believed.

## 1. The guest's download did nothing

`<a href={signedUrl} download>` has been in the gallery since phase 5. **`download` is ignored
for a cross-origin href**, and every photo URL is cross-origin — the bytes come from Supabase
Storage, the app does not. So the attribute was inert: the tap opened a JPEG in a new tab named
after a UUID and left the guest to long-press it. Inside an in-app browser — Instagram,
WhatsApp, where a scanned QR usually lands — that tab can dead-end with no save affordance at
all. This is the guest's entire payoff and it has never worked as written.

The phase-5 gate asserted that the anchor **existed**. That is precisely the attribute that
does nothing. Asserting an attribute is present is not a gate on the behaviour it is supposed
to produce — the fourth instance of the same shape in this project, after the one-schema law-9
check, the "is it hashed but is it readable" law-6 check, and the null verdict.

Fixed by fetching the bytes and saving a blob: `blob:` is same-origin, so `download` is
honoured and the file gets a name a person recognises (`laqta-<code>-1.jpg`) instead of a
storage key. The anchor stays as the real fallback and the handler returns false rather than
swallowing failure, so a dead uplink or an old browser lands exactly on the behaviour that
shipped before. **The new gate clicks the control and waits for a download event**; with the
old markup restored it times out having never fired.

## 2. The bilingual pass was already done — nothing was keeping it done

On inspection the substance was there: 237 keys in both languages with no gaps, logical CSS
properties throughout, `dir` and `lang` set on `<html>`. The recorded item was stale. What was
genuinely missing was any check that keeps it true. A first-class contract requirement that
nothing asserts is one busy afternoon from decaying — one English string on a kiosk, one
`margin-left` in a hurry, and nothing anywhere says a word.

So this does not redo the translation, it makes it **enforced**: the dictionaries must stay in
step, no Arabic value may be the English one pasted across, no physical direction property may
enter the styles, and every surface in Arabic must flip, fit without sideways scroll, and show
no untranslated dictionary string.

One real find: the language switcher's own `aria-label` was the hardcoded English word
"language" — the screen-reader name of the control that switches the app to Arabic.

**And the gate caught itself being too shallow.** The first version walked `/#/guest` and called
the guest side covered. `/#/guest` with no code is a single input: the tiles, the download and
the share row all sit behind a lookup, so a hardcoded English label on any of them was
invisible. Injecting one proved it — the gate stayed green. It now opens a real gallery first.
A surface is not covered until the gate reaches the state where its strings actually render.

## 3. A deploy could not reach an installed station

The service worker used one constant cache name and an `activate` that deleted only caches
whose name differed from it — which none ever did. Two consequences:

- Any asset at an unchanged URL was served from cache **forever**. The manifest, the icon,
  anything added to `public/`: a deploy never reached a station that had already installed.
- Every deploy **added** its bundles to a cache nothing pruned.

The second is the one that matters. This origin's storage is also where the outbox lives, and
browsers evict a whole origin under pressure — so unbounded cache growth is a slow leak pointed
at law 1, and it fires on the night a station has been through twenty deploys.

The shell is now named after a digest of what it references: a new build is a new cache, older
ones are deleted on activate, and the new one is staged during install and promoted only once
whole, so a station updating while offline is never left with a half-built cache and no way
back. **The model is deliberately not versioned with it** — seventy megabytes of
content-addressed shards re-downloading on a venue uplink because a button colour changed would
be its own outage. Everything else same-origin is stale-while-revalidate: never slower than the
cache, and a changed asset reaches the station on the next open instead of never. Network-first
would have been the obvious fix and the wrong one — it hangs a booth on a dying uplink, which
is the failure this whole project exists to prevent.

This gate is the one browser file that drives **no mock**: it exercises the real built worker
and simulates a deploy by changing the worker's own bytes on disk. `registration.update()` on
identical bytes is a no-op, so a test using it would have proved nothing about activate — the
first version did exactly that and passed for the wrong reason.

## 4. The sweeper log was ledger item 3, in the table that watches for it

Three sweepers run every minute, each writing a row whether or not it changed anything, and
nothing had ever deleted one: **9,680 rows in three days** of an otherwise idle project, well
over a million a year.

The trap is why this is not a one-line DELETE. Some of those rows are not heartbeats, they are
**evidence** — the 90-second probe proving law 4's clock survives the runtime, the thumbnail
probe for law 7, the anon-reachability probe for law 9, and the hourly storage self-test whose
report `gate_storage()` and `gate_sessions()` read on every run. Retention by age alone would
have deleted the proofs the suite stands on, and the suite would either have gone red or, far
worse, stayed green while asserting against nothing.

A row is now removed only when it is **both** outside the seven-day window **and** not among its
sweeper's newest 200. Probes run at most hourly, so they never leave the newest-200 and are
structurally safe; the minute-cadence heartbeats settle at a bound. Each of the three fixtures
in the gate isolates one rule, so neither number can be explained by the other.

## 5. A second way to take a photo, sitting unused in the codebase

`sendCapture` was unreferenced, exported, and looked entirely correct: reserve, upload,
register, confirm, in one call — straight to the network, with no queue behind it. Nothing
called it. But the first person reaching for "just send this one shot" would have written the
venue-internet-dies failure back into the product, and it would have reviewed cleanly.

Ledger item 9 is this shape at API scale; it is no better inside one file. Deleted, with the
reason left in its place. Every shot goes through the outbox, and it survives the network dying
because that is the only path there is.

## Regression

| Suite | Result |
|---|---|
| `run_all_gates()` on the live database | **202/202** |
| Browser gates (phases 1–7 + outcome) | **33/33** |
| Migration 0038 | byte-identical to its applied statements |

Migration 0038's first apply failed its own self-verification on a number I had reasoned wrong
— I expected 201 survivors where the correct answer was 200, because the recent row falls
inside the newest-200 rather than beside it. The transaction rolled back whole. The gate now
uses three separate fixtures so each rule is proved on its own.

## Still open

- **The OpenRouter key is not in Supabase secrets.** Owner's browser, under two minutes:
  Supabase dashboard → Project Settings → Edge Functions → Secrets → add `OPENROUTER_API_KEY`.
  No deploy needed. Until then no restyling happens, honestly and provably: the job fails
  `AI_NOT_CONFIGURED`, money and generation are both refunded, and the operator publishes the
  original.
- **The repository is still public.** GitHub → Settings → Danger Zone → Change visibility.
- **Repo↔deploy byte-equality for the Edge Functions.** Noted as closing at freeze by hash
  handshake: the architect pulls the deployed contents through the connector, the repo copies
  are hashed here, and the two are compared. Nothing to do until then.
