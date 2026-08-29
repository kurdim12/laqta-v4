# LAQTA v3 — Runbook

How the system is deployed, seeded, watched and repaired. The event-day page
(`EVENT-DAY-CHECKLIST.md`) is for the show; this is for the people who set it up and fix it.

---

## 1. What the system is made of

| Piece | Where it lives | What it is |
|---|---|---|
| The app | A folder of static files, dragged onto any host | One PWA, hash-routed, installable per station |
| The API | One Supabase Edge Function, `api` | The only way the browser reaches the database |
| The AI runner | Edge Function `ai-worker`, poked by `pg_cron` | Owns its own clock; queued jobs, leases, spend |
| The database | Supabase Postgres | Every rule that matters is enforced here |
| Storage | Two private buckets: `photos`, `thumbs` | Signed reads only; walls can only reach `thumbs` |

The browser holds no database credential. The anon key can execute nothing — this is checked
by the gate suite on every run, and it is why there is exactly one API layer.

### One setting that must never change

**PostgREST's exposed schemas stay `public` (plus `graphql_public`).**

This is not a preference; it is load-bearing. Two Postgres extensions the project uses live in
their own schemas and grant EXECUTE to `PUBLIC`, which every role inherits — `net` (pg_net:
an HTTP request emitter) and `cron` (pg_cron: the scheduler). Those grants belong to
`supabase_admin`, and this project's `postgres` role cannot revoke them; that was established
by trying, not by assuming.

What keeps them out of reach is that PostgREST resolves RPC only inside its exposed schema. A
live request carrying the real anon key for a routine outside `public` comes back
`404 PGRST202 — "Searched for the function public.…"`. That response is recorded in
`sweeper_runs` and asserted by the gate suite on every run.

Adding `net`, `cron` — or any schema — to the exposed list would hand anyone holding the
public anon key an HTTP request emitter and a job scheduler. Don't. (`cron` is additionally
protected: anon has no USAGE on that schema at all.)

## 2. Deploying the app

The deploy is a folder, not a command:

1. Build produces `dist/`.
2. Drag the **contents** of `dist/` (not the folder itself) onto the host —
   Cloudflare Pages "Direct Upload", or Hostinger's file manager into `public_html`.
3. Open the site once. Every station URL is a hash route off that same page, so nothing on
   the host needs rewrite rules.

**The offline background-removal model** ships as `dist/models/` (about 40MB, delivered as two
zips because of an upload size limit). Without it, cutouts silently fall back to the plain
photo — the system does not break, it just stops cutting figures out. Unzip both into
`dist/models/` before the drag if you want cutouts.

### Station URLs

Replace `<event>` with the event's slug.

| Station | URL |
|---|---|
| Booth (operator) | `#/booth` (after `#/operator/login`) |
| Self-serve kiosk | `#/kiosk` |
| Shirt kiosk | `#/shirt` |
| Avatar kiosk | `#/avatar` |
| Operator queue | `#/queue` |
| Control room | `#/control` |
| War room | `#/war` |
| Grid wall | `#/wall/<event>` |
| LED wall | `#/wall/<event>/led` |
| Lightbox wall | `#/wall/<event>/lightbox` |
| Guest gallery | `#/guest` (or `#/guest?code=XXXX`) |
| Guest landing | `#/g/<event>` |
| QR kit (printable) | `#/qr/<event>` |
| Admin | `#/admin` (after `#/admin/login`) |

## 3. Seeding an event

Through the admin console, in the browser: create the event, set branding and guest mode,
create operators, set the shirt catalogue, enter cues and crew tasks.

For a repeatable rehearsal there is a database function that does all of it in one call, and
running it twice changes nothing:

```sql
select seed_demo_event('rehearsal', 'Dress Rehearsal', 'booth1', '<pin>');
```

It creates a live, code-per-shot event with three shirts, four cues, four crew tasks and one
operator. The PIN is a parameter, so no credential is stored in the schema or in any file.

## 4. Secrets

`.env` in the repo holds only the public project URL and the anon key — both are public by
design. Everything else lives in **Supabase → Project Settings → Edge Functions → Secrets**,
and nothing in the repo, the app bundle, or any chat message ever contains one:

| Secret | What it lights up | Without it |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | The API layer itself (set automatically) | Nothing works |
| `OPENROUTER_API_KEY` | Paid AI restyles | Restyles fail honestly as `AI_NOT_CONFIGURED`, the reservation is refunded, the original publishes |
| `ANAM_API_KEY` | The avatar kiosk's live host | The kiosk runs welcome mode: greeting, working camera, same queue |

After adding a secret, nothing needs redeploying. Each surface asks whether it is configured
and starts using it — the avatar kiosk re-checks every minute; `ops.health` shows the state as
configured/missing pills in the control room.

## 5. Watching a live event

The control room (`#/control`) is the whole picture, refreshed every two seconds:

- **Stations** — online/offline and each device's queue depth. A station goes offline eight
  seconds after its last heartbeat; the control room shows that within ten.
- **Spend** — dollars used against budget, generations used against the cap.
- **Failures (last hour)** — from the deduped telemetry, so a storm of identical errors is one
  line with a count, never a flood.
- **Telemetry dropped** — how much detail the per-device cap discarded this hour. Non-zero
  means a device is noisy; the signal is still there, the detail is not.
- **Sweepers** — each one reports every pass, including quiet ones. A sweeper that stops
  reporting is a sweeper that has stopped.
- **Activity and overrides** — what happened, and who overrode what.

## 6. Diagnosing

**"A photo is missing."** It is not. Look at the station's queue depth in the control room —
photos live on the device until the server confirms them, and the device retries forever.
If the operator's booth shows a red "needs attention" pill, that shot could not be encoded on
that device; it is still in the queue and still retried, and it will need to be re-taken.

**"The wall is stale."** The wall shows its last good state on purpose. Check whether the wall
screen has network; check whether **freeze wall** is on. A wall never goes blank because it
lost the network — going blank is worse than going stale.

**"Restyles aren't happening."** In order: is **pause AI** on? Has the spend or generation cap
been reached? Is `OPENROUTER_API_KEY` present (control room pills)? Each of those is a designed
stop, and each leaves the original publishable.

**"A station shows offline but I'm looking at it."** Its heartbeats are not arriving — a
network problem, not a photo problem. The photos on it are safe and will sync.

**"Someone is guessing guest codes."** They cannot get far: codes are 14 symbols from a
32-symbol alphabet and every lookup attempt is counted in the database, per client, and refused
past the limit. The counter survives restarts.

## 7. Repairing

| Situation | Fix |
|---|---|
| Operator locked out | Admin → unlock. Logged in the audit trail. |
| Wrong photo published | Queue → hide or delete. Logged. |
| Wrong restyle | Queue → use original. The branded original replaces it. |
| Wrong wall layout | Admin → wall layout. Walls pick it up on their next poll. |
| An event's settings are wrong | Admin. Every setting is per-event: changing one event cannot touch another. |
| A migration must be added | New numbered file in `supabase/migrations/`, applied through the Supabase connector. **Never edit an applied migration.** Every migration runs the gate suite before it finishes, so a change that breaks a law rolls back whole. |

## 8. The gate suite

Two halves, both re-runnable, both cumulative:

```sql
select * from run_all_gates() where not pass;   -- expect zero rows
```

```
npm run gate:all          -- every browser gate, phases 1 through 7
npm run gate:phase7:full  -- the rehearsal with the full ten-minute outage
```

The SQL half runs against the live database and covers the schema-enforced laws. The browser
half drives real pages in a real browser against a stand-in API that mirrors the real
contract. Both must be green before any change is considered done — that is law 13, and it is
why every phase of this build has a permanent, executable record.

## 9. The freeze

After the dress rehearsal passes, the architecture is frozen (law 14). Frozen means: no new
dependencies, no new surfaces, no schema changes that are not a fix for something the
rehearsal found. Bug fixes are allowed and go through the same gate suite. The freeze is part
of the system's lifecycle, not a mood — v1's worst day was the day its architecture changed
during an event.
