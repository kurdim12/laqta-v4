# LAQTA v3

The live-event photo platform of **MaraNasi** (Amman, Jordan).

Capture at an event → optional AI restyle → operator approval → live walls → guest delivery. Built to keep
running when the venue internet does not.

**`CLAUDE.md` in this folder is the build contract and the source of truth.** Read it before changing anything
here. It carries the 14-law problem ledger, the fixed feature list, the stack decisions, and the phase plan.

## Layout

| Path | What it is |
|---|---|
| `CLAUDE.md` | The build contract — laws, scope, phases, report format |
| `DEFERRED.md` | Ideas parked outside the approved feature list |
| `docs/` | Phase reports, runbooks, and decision records |
| `supabase/migrations/` | Numbered SQL migrations. **Applied migrations are never edited.** |

## Backend

Supabase project `maranasi-laqta-v3` (`bdzdvlnmocojsifdkpvd`, eu-central-1). Schema changes are numbered
migration files applied through the Supabase MCP connector.

## Secrets

`.env` carries only the public project URL and the anon key. The service-role key and all provider keys
(OpenRouter and friends) live only in Supabase secrets — never in this repository.
