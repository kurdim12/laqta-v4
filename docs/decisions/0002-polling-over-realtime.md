# Decision 0002 — Walls poll through the API; Supabase Realtime is not wired to browsers

**Date:** 2026-08-29 · **Status:** Decided during Phase 2, recorded for the architect's review

The stack section names "Supabase Realtime with a polling safety net". Wiring browser Realtime
to postgres changes requires the anon role to hold RLS SELECT on the watched tables — and
migration 0008's hardening (verified by `assert_schema_locked()`, asserted by every gate) is
precisely that anon can touch **nothing**. The two are structurally incompatible.

Two architectures diverge:
- **Open a narrow anon read** for wall tables, gaining push updates, weakening the lockdown.
- **Poll through the single API layer** (3–5s), keeping law 9 and the anon lockdown absolute.

Polling was chosen: the walls' user-visible requirement (new photos appear within seconds,
self-recovery after cuts) is met — proven by the Phase 2 browser gate — and the safety net IS
the mechanism. If the architect wants push later, it arrives as a new decision, not a drift.
