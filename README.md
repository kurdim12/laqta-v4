# LAQTA v3

The live-event photo platform of **MaraNasi** (Amman, Jordan).

Capture at an event → optional AI restyle → operator approval → live walls → guest delivery. Built to keep
running when the venue internet does not.

**`CLAUDE.md` in this folder is the build contract and the source of truth.** Read it before changing anything
here. It carries the 14-law problem ledger, the fixed feature list, the stack decisions, and the phase plan.

## Start here

| If you are… | Read |
|---|---|
| The owner, with four things only you can do | `docs/OWNER-CHECKLIST.md` |
| Running an event tonight | `docs/EVENT-DAY-CHECKLIST.md` |
| Setting it up, or fixing it | `docs/RUNBOOK.md` |
| Reviewing what was built and how each law died | `docs/RUNNING-LOG.md` |
| Changing anything | `CLAUDE.md`, then `tests/gate/README.md` |

## Layout

| Path | What it is |
|---|---|
| `CLAUDE.md` | The build contract — laws, scope, phases, report format |
| `DEFERRED.md` | Ideas parked outside the approved feature list |
| `docs/` | Phase reports, runbooks, checklists, and decision records |
| `src/` | The one PWA: every station is a hash route off the same page |
| `supabase/migrations/` | Numbered SQL migrations. **Applied migrations are never edited.** |
| `supabase/functions/` | The single API layer and the AI job runner |
| `tests/gate/` | The browser half of the gate suite, phases 1–7 |

## The gate suite

Nothing is done until both halves are green — that is law 13, and it is why every phase of this
build has a permanent, executable record.

```sql
select * from run_all_gates() where not pass;   -- expect zero rows
```

```
npm run gate:all          # every browser gate, phases 1 through 7
npm run gate:phase7:full  # the dress rehearsal, with the full ten-minute outage
```

## Backend

Supabase project `maranasi-laqta-v3` (`bdzdvlnmocojsifdkpvd`, eu-central-1). Schema changes are numbered
migration files applied through the Supabase MCP connector.

## Secrets

`.env` carries only the public project URL and the anon key. The service-role key and all provider keys
(OpenRouter and friends) live only in Supabase secrets — never in this repository.
