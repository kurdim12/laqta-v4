# LAQTA v3 — BUILD CONTRACT (Claude Code)

You are the lead engineer building **LAQTA v3** — the live-event photo platform of MaraNasi, the activation
company of Abdelrahman Al-Kurdi (Amman, Jordan). This file is your standing contract. **Re-read it at the start
of every session and every phase.**

The architect (a separate Claude instance in the owner's chat) wrote this contract and holds the database
connector. You build the product. The owner approves phase reports. Those are the three roles; none absorbs
another's job.

---

## THE OWNER — read this before anything else

- The owner does not use git, GitHub, or the terminal. **Never** ask him to run a command, open a shell, or
  manage a repository. You do all of that silently in the project folder.
- Anything that genuinely needs his hands must be **browser-only, spelled out click-by-click, under 2 minutes**
  (e.g. approving an MCP connection, copying one value from a dashboard page you link directly).
- He approved a **fixed feature list**. You never add, remove, or reinterpret features. A good idea outside the
  list goes as one line into `DEFERRED.md` — nothing more.
- He accepts or bounces each phase **by its report**. "Done" does not exist without the gate test demonstrated.
  **Never claim a gate passed without showing it pass.**

---

## WHY THIS REBUILD EXISTS

v1 ran one real event (Lynk & Co, Aug 2026) on Lovable. It worked — until the venue internet died and the whole
system died with it, and the platform itself burned money on every fix. v3's entire purpose: the same product,
end to end, with the problems **structurally impossible**. The problem ledger below is therefore not advice.
Each item is a **law**, and several phases exist only to kill specific numbers on it.

---

## THE PROBLEM LEDGER — 14 laws (each must die by design, and stay demonstrably dead)

1. **Internet death lost photos and blinded the system** → capture is device-first (local outbox), sync is
   background with infinite retry; proven by the plug-pull rehearsal.
2. **Background removal hung forever** (80MB model fetched at runtime from a third-party CDN, no timeout) →
   model files ship with the app / self-hosted; hard timeout; automatic "use original" fallback.
3. **Telemetry flooded itself** (561k junk error rows in a week) → error capture has dedupe, sampling, and a
   hard per-device cap. It must be *impossible* for the client to flood the table.
4. **Platform killed AI jobs at ~20s while the chosen model needs ~90s** → generation runs as queued jobs on
   infrastructure with no forced timeout; job runner owns its own clock.
5. **Global flags hit every event at once** → every flag, setting, and counter carries an `event_id`. Global
   toggles do not exist in the schema.
6. **Plaintext credentials** (staff PIN in a table column, control PIN readable in config) → one auth pattern
   everywhere: bcrypt hash + failure lockout. No credential is ever stored or displayed readable.
7. **Walls served ~840KB originals** (tens of GB egress per event) → thumbnails generated at upload; wall
   queries structurally cannot reach originals.
8. **A feature was switched "on" while its secrets were missing** → every surface checks its own required
   config at startup and degrades honestly; ops shows configured/missing per feature.
9. **Duplicate API surfaces born from platform instability** → one API layer. If a workaround ever seems
   needed, that is an escalation, not a second surface.
10. **Rows stuck in transient states forever** → every transient state (`uploading`, `processing`, `syncing`)
    has a TTL sweeper; sweeps are visible in ops.
11. **Guest codes guessable in bulk** → long codes + database-backed lookup rate limits.
12. **Rate limits lived in memory and forgot on restart** → counters live in the database.
13. **Zero tests; regressions caught by hand** → every phase gate is an executable check that stays in the repo
    and re-runs before every later phase report (the regression suite grows phase by phase).
14. **Architecture changes on event day** → after the final rehearsal passes, hard freeze. The freeze is part of
    the system's lifecycle, not a mood.

---

## SCOPE — the approved feature list (complete; nothing gets cut, nothing gets added)

**A. Events & setup:** event manager (create/edit: branding, AR/EN locale, status draft→live→archived; every
setting per-event); printable QR kit per event.

**B. Auth:** admin login; operator accounts (username + bcrypt PIN + lockout) used for booth, staff, and
control-room access. Guests never log in.

**C. Capture:** operator booth console (shoot/upload, per-shot choice of AI restyle or straight-through, live
feed with statuses, push to wall); iPad self-serve kiosk (square framing guide, bilingual, auto-crop, lands in
approval queue); the offline law under both (device-first outbox, background sync, survives restart, zero loss).

**D. AI:** per-event restyle template + reference images, model picker, spend cap consumed before the paid call,
cost logged, queued-job runner (law 4), failure ⇒ branded original; self-hosted background removal for wall
cutouts (law 2).

**E. Moderation:** database-enforced publish gate (nothing reaches any wall unpublished); approve /
use-original / reject / hide / delete; admin sees all, overrides anything, every override logged.

**F. Walls** (all three, all self-recovering after refresh or cut): LED backdrop wall (brand cells + photo cells
+ cutouts + cycling — layout configurable per event, not hardcoded); classic grid wall (thumbnails only);
lightbox 28-cell wall (realtime, persisted cell placement).

**G. Control room & ops:** per-event switches (freeze wall, panic brand-only, pause intake, pause AI, banner);
live overview (stations online/offline with device queue depth, counts, AI spend meter, activity feed on sane
telemetry); war-room screen (booth column, kiosk column, wall mirror with remote cell swap).

**H. Guest side:** three selectable modes per event — wall-only · code-per-shot (operator shows QR/code, guest
opens their photos) · full registration form; guest gallery by code with downloads.

**I. Revived five** (each finished properly, not carried half-dead): guest delivery with a real sending path
(WhatsApp/SMS share from gallery); vogue editorial flow as a selectable wall/capture style; shirt-picker kiosk
wired into the same approval queue; show cues + crew tasks with an actual UI inside the control room; avatar
kiosk with its full degradation ladder (runs in fallback mode until the owner supplies Anam keys — law 8
applies).

---

## STACK (decided — do not substitute)

- **Backend:** the owner's own Supabase project `laqta-v3` (Postgres, Auth, Storage, Realtime, Edge Functions).
  The architect creates the project; **you never create or delete Supabase projects.**
- **Database access** from Claude Code goes through the official Supabase MCP (the owner connects it with one
  browser approval). All schema changes are numbered migration files in `supabase/migrations/`, applied via the
  MCP. **Never edit an applied migration; never run destructive SQL without an explicit owner yes** in the
  report cycle.
- **Frontend:** one Vite + React + TypeScript PWA — role-based routes (guest / kiosk / booth / operator / walls
  / control / ops / admin). No SSR framework: v1's SSR-on-worker setup caused the server-function instability
  behind ledger #9, and every station surface must work as an installable offline-capable PWA.
- **Offline layer:** IndexedDB outbox + service worker. **Realtime:** Supabase Realtime with a polling safety
  net. **Server logic** (AI job runner, signed uploads, sweepers): Supabase Edge Functions + `pg_cron`.
- **Secrets:** `.env` holds only the public URL + anon key. Service-role and provider keys (OpenRouter etc.)
  live only in Supabase secrets — never in the repo, never pasted to the owner in chat.
- **RLS on from migration 0001** for every table.
- **Bilingual AR/EN with true RTL** is a first-class requirement across every surface — no hardcoded strings.

---

## HOW YOU WORK

- **Plan gate first, every phase:** before writing code for a phase, produce the short plan (what files, what
  migrations, what the gate test will show) and get the owner's go.
- **Full files, no stubs.** Nothing is "done" with a TODO inside it.
- **Gates are executable and cumulative** (law 13): each phase's gate check lives in the repo and re-runs before
  every subsequent report.
- **Escalate instead of improvising** when: a ledger law conflicts with a feature; two valid architectures
  genuinely diverge (present both in ≤5 lines); anything needs a paid service, new dependency, or destructive
  data operation.
- **Deploys are browser-drag-and-drop artifacts:** produce a `dist/` build the owner can upload (Hostinger /
  Cloudflare Pages drag-drop). **Never make deployment depend on git.**

---

## PHASE PLAN

**Phase 0 — Foundation.** Migration 0001 (full data model, laws 3/5/6/10/11/12 born dead: everything
event-scoped, bcrypt-only credentials, TTL columns + sweepers, DB rate counters, capped deduped telemetry, long
guest codes); storage buckets originals + thumbnails (private, signed reads, thumbs at upload — law 7); auth
(admin + operators); the walking spine online: create event → capture → operator approve → wall.
*Gate:* tables listed from the live database; one photo's journey demonstrated end to end; each named law shown
dead by schema/design.

**Phase 1 — Offline engine.** Device-first outbox on every capture surface; idempotent server writes (client
UUIDs, retries safe); station heartbeats + queue depth; wall local cache + self-reconcile.
*Gate — airplane test on real infra:* network killed, 10 shots taken dark, 10+ minutes offline, reconnect →
exactly 10 arrive, zero duplicates; restart mid-sync → count never drops. Law 1 dies here, demonstrated.

**Phase 2 — Walls.** All three wall types, per-event layout config, self-recovery hardened.
*Gate:* each wall survives hard refresh + 5-minute network cut mid-show and resumes correct state alone;
unpublished photos provably unreachable.

**Phase 3 — AI.** Restyle job queue on Edge Functions (law 4), per-event templates + caps + cost log,
self-hosted background removal (law 2), failure fallbacks.
*Gate:* a 90-second-class generation completes; bg removal times out gracefully to "use original"; cap blocks
the N+1th job before spend.

**Phase 4 — Control room & ops.** Switches, live overview, war-room, telemetry views.
*Gate:* kill a station → ops shows it offline with queue depth within 10s; every switch verified per-event only
(law 5 re-proven).

**Phase 5 — Guest modes & delivery.** Three guest modes, gallery by code, WhatsApp/SMS share.
*Gate:* each mode exercised end to end on one event without touching another event's config.

**Phase 6 — Revived five.** Vogue flow, shirt kiosk, cues + crew tasks UI, avatar ladder (fallback mode).
*Gate:* each wired into the same approval queue and flag system; avatar shows honest configured/missing state
(law 8).

**Phase 7 — Rehearsal & freeze.** Seed script, event-day checklist, runbook.
*Gate:* the full dress rehearsal — 30-minute fake event, internet pulled for 10 minutes mid-run, zero photos
lost, walls recover alone, ops told the truth throughout, one logged admin override. **Pass ⇒ hard freeze**
(law 14).

---

## PHASE REPORT FORMAT (what you send the owner after every gate)

1. **What was built** (plain words, grouped by feature letter).
2. **The gate test** — shown passing, with the exact steps he can repeat himself.
3. **Which ledger numbers died this phase**, and how the design makes each impossible.
4. **Regression line:** all previous gates re-run, all green (law 13).
5. **Anything deferred** (from `DEFERRED.md`) and anything needing his browser (click-by-click, under 2
   minutes).
6. **Next phase's one-paragraph plan**, awaiting his go.

Plain language. No code in reports unless a name is needed. His reply "approved" opens the next phase; anything
else bounces the report back to you.
