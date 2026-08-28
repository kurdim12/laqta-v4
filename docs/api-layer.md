# The API layer

**One Edge Function, `api`, deployed to `maranasi-laqta-v3`. Version 1, status ACTIVE.**

`https://bdzdvlnmocojsifdkpvd.supabase.co/functions/v1/api`

## Why one function and not several

Law 9: *"one API layer. If a workaround ever seems needed, that is an escalation, not a second
surface."* v1 grew duplicate API surfaces because the platform was unstable and each workaround became
permanent. So there is exactly one HTTP entry point here. It takes a POST, dispatches on an `action` string,
and every action is a named entry in one table in one file.

This is not merely a convention. Migration `0008` revoked every `EXECUTE` grant from the `anon` and
`authenticated` roles, so **the browser cannot reach the database at all** except through this function. A
second surface would have to be built deliberately; it cannot appear by accident.

## Authentication

`verify_jwt` is off, deliberately, and the function authenticates itself:

- **Operators and admins** get an HMAC-signed, expiring session token from `operator.login` / `admin.login`.
  The signing key is derived from the service-role key inside the process, so there is no extra secret for the
  owner to manage. A session states who the caller is and which event they belong to — an operator cannot name
  a different event, and the composite foreign keys from `0008` are the second line of that same defence.
- **Walls and guests are public by design.** A wall screen has no operator behind it, and per feature B guests
  never log in. Supabase's built-in JWT gate cannot express "public for two actions, session-bound for the
  rest", which is why it is off and this file does the work instead.

## Where the laws live in this file

| Law | How this layer honours it |
|---|---|
| 7 | `wall.photos` signs **thumbnail** URLs only. It calls `wall_photos`, whose return type has no `storage_path` column, so no argument to this action can make it name an original. |
| 7 | `photo.uploadUrl` issues two signed URLs — original and thumbnail — so a thumbnail exists at upload time. The database then refuses to let a photo become `ready` without one. |
| 1 | `photo.register` is idempotent on the client-minted id. This is the write an offline outbox retries; retrying cannot produce a second photo. |
| 11 | `guest.photos` charges the lookup limit **before** returning a gallery, so fetching photos cannot be used to skip past the enumeration limit. |
| 8 | `ops.health` reports whether each provider key is present — never its value — so a surface can say honestly that it is not configured. |
| 5 | Switch changes carry the acting operator or admin, and land in `audit_log`. |

## Secrets

The function reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, which Supabase injects. Provider keys
(`OPENROUTER_API_KEY`, `ANAM_API_KEY`) are read only to report presence in `ops.health`; nothing in Phase 0
spends them. No key is logged, returned, or written to this repository.

## Verification status — stated honestly

The function is deployed and ACTIVE, and every database function it calls is covered by the 39-check Phase 0
gate. **It has not been exercised over HTTP from the build session**: this environment's egress policy blocks
`bdzdvlnmocojsifdkpvd.supabase.co`, and the correct response to a policy denial is to report it rather than
route around it. Confirming the HTTP surface end to end is the first task of the next phase of work, alongside
the PWA that calls it.
