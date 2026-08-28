# Decision 0001 — Reconciling the repository with the live database

**Date:** 2026-08-28
**Status:** Proposed — awaiting owner's go
**Context:** discovered at the start of the first build session

---

## What was found

The git repository was **completely empty** — no commits, no files, only an initialised `.git` folder.

The Supabase project **`maranasi-laqta-v3`** (`bdzdvlnmocojsifdkpvd`, eu-central-1) was **not** empty. It already
carried:

- **7 applied migrations** (`0001_core` … `0007_pgcrypto_search_path`), about 33,000 characters of SQL
- **6 tables** — `events`, `operators`, `operator_login_attempts`, `photos`, `ai_jobs`, `ops_events`
- **36 functions**, every one of them `SECURITY DEFINER` with a pinned `search_path`
- **2 private storage buckets** — `photos` and `thumbs`, 15 MB limit, image MIME types only
- **1 `pg_cron` job** — `sweep_ai_jobs`, running every minute
- **0 rows in every table** — nothing has ever been captured through it
- **0 Edge Functions deployed**

So the schema existed **only inside the database**. The repository could not rebuild it, and nobody could review
it. That breaks two contract rules at once: *"All schema changes are numbered migration files in
`supabase/migrations/`"* and law 14's hard freeze, which is meaningless if the thing being frozen is not in
version control.

## The decision

**Recover the 7 applied migrations out of the database into `supabase/migrations/` verbatim, adopt them as the
Phase 0 baseline, and continue at `0008`.**

Each file is written from `supabase_migrations.schema_migrations.statements`, character-for-character, under a
header marking it as an already-applied migration that must never be edited. The only difference between the
file and the applied statement is a single POSIX trailing newline at end of file. Every recovered body was
verified by comparing its character count against `length()` of the copy in the database.

The migration filenames keep the exact version stamps the database recorded (`20260824104808_0001_core.sql` and
so on), so the repository maps one-to-one onto what is actually applied.

## Why not start clean instead

Every table holds zero rows, so wiping the project and writing one comprehensive `0001` — matching the letter of
the contract's Phase 0 description — is genuinely available and would produce a tidier history.

It was **not** chosen because it is a destructive database operation, and the contract requires an explicit
owner "yes" before any of those. It is offered to the owner as a one-line choice in the Phase 0 plan. Recovering
is the reversible default: nothing is lost by adopting the existing migrations, and a reset remains possible
later.

The substance of the contract's Phase 0 requirement — *"the full data model, laws 3/5/6/10/11/12 born dead"* —
is judged by the **end state of the schema**, not by how many files it took to get there.

## Consequences

- The repository is now the reviewable source of truth for the schema.
- `0001`–`0007` are frozen. Every correction to them arrives as a new numbered migration, never an edit.
- Phase 0 is **not** complete. The recovered migrations are a partial foundation — a working spine for events,
  operators, photos, AI jobs and telemetry — but several ledger laws are not yet dead in them, and there is no
  API layer or frontend at all. The Phase 0 plan enumerates the gap.
