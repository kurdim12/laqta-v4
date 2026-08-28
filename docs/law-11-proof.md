# Law 11, shown dead

**Run against the live database on 2026-08-28, immediately after migration `0013` was applied.**
501 codes were minted and measured, then the code space was attacked by bulk enumeration.

## The codes themselves

| Measure | Result |
|---|---|
| Codes minted | **501** |
| All distinct | **yes** |
| All exactly 14 symbols | **yes** |
| All inside the declared alphabet | **yes** |
| Distinct symbols actually produced across all codes | **32 of 32** |

The last row is the one that makes the keyspace real rather than nominal. A generator that silently favoured
part of its alphabet would shrink 32^14 to something far smaller; every one of the 32 symbols appears.

That is by construction: codes come from `gen_random_bytes`, and 256 is exactly eight times 32, so taking each
byte modulo 32 is unbiased. The alphabet is Crockford base32 with **I, L, O and U removed**, so a code read
aloud across a loud activation floor cannot be transcribed into a *different valid code*. The keyspace is
32^14 — about 4.5 x 10^21.

## Bulk enumeration

Forty guesses were fired from one client against a limit of thirty:

| Measure | Result |
|---|---|
| Attempt at which guessing was refused | **31** |
| A genuine code, from a different client, immediately after | **ok** |

Length alone only raises the cost of guessing; it does not cap it. The counter does. Every lookup consumes a
row in `platform_rate_limits` **before the code is resolved**, so guessing is bounded by attempts per window
rather than by the attacker's bandwidth. The counter lives in the database, which is law 12: restarting the API
layer does not forgive an enumeration already in progress.

The limit is per client, not global, which is why the second row matters — one attacker cannot lock every guest
at the event out of their photos by hammering the endpoint.

The charge is taken on **every** attempt, hit or miss. Charging only for misses would let an attacker who found
one valid code hold open a free channel; charging after resolution would leave resolution itself unbounded.

## The publish gate reaches the guest too

| Check | Result |
|---|---|
| Photos returned by the gallery for a valid code | **1** |
| Unapproved photos among them | **0** |

An unapproved photo is not anyone's to collect, including the person in it. The gallery filters on
`approved = true and status = 'ready'`, the same condition the wall uses.

## One deliberate difference from the wall

`api_guest_photos` returns `storage_path`; `wall_photos` does not, and must not. A guest downloading the
full-size picture they posed for is the feature; a wall serving 840KB originals to a room for eight hours is
the v1 egress failure. Law 7 is about the second, and the split return types are how the two are kept apart.
