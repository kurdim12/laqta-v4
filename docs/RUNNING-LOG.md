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
