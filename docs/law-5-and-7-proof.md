# Laws 5 and 7, shown dead

**Run against the live database on 2026-08-28, immediately after migration `0012` was applied.**
Two events, Alpha and Beta, were created side by side. Every switch was flipped on Alpha only.

## Law 5 — a switch exists only on the event it belongs to

| After flipping all five switches on Alpha | Alpha | Beta |
|---|---|---|
| Wall frozen | **true** | **false** |
| Panic brand-only | true | **false** |
| Intake paused | **true** | **false** |
| AI paused | true | **false** |
| Banner active | true | **false** |

Beta is untouched on every one. This is not careful coding — there is nowhere for a global switch to live.
Each of these is a **column on the `events` row**. No settings table without an `event_id` exists, so a switch
that reached two events at once would have to be a column that is not on a row, which is not a thing.

## The switches refuse work; they do not merely grey out a button

| Attempt | Result |
|---|---|
| Upload to Alpha while its intake is paused | **refused** — `INTAKE_PAUSED` |
| The same call against Beta | **succeeded** |
| Enqueue a generation on Alpha while its AI is paused | **refused** — `AI_PAUSED` |
| Move Beta backwards from `live` to `draft` | **refused** — `ILLEGAL_STATUS_TRANSITION` |

Hiding a control in the interface is not a control, because the interface is not the only way in. Each of these
is raised by the database, so it holds against a stale tab, a queued offline write, or a direct call.

## The wall obeys, and recovers

| State | Approved photos | Wall shows |
|---|---|---|
| Normal | 1 | **1** |
| Panic brand-only on | 1 | **0** |
| Panic cleared | 1 | **1** |
| Frozen, then a third photo approved | 3 | **2** — it does not advance |
| Unfrozen | 3 | **3** — it catches up |

A freeze is a timestamp, not a flag, because "frozen" has to mean *the wall keeps showing what it had*. Photos
approved after the freeze instant are simply not in the answer until the freeze is lifted.

**One nuance worth writing down.** `wall_frozen_at` is set with `now()`, which in Postgres is transaction start
time. A freeze and a photo created inside the *same* transaction therefore share an instant, and the photo is
included. That is correct — the comparison is `<=` — and it does not arise in operation, where the control room
freeze and a booth upload are always separate transactions. It is recorded here because the first run of this
test appeared to show the freeze failing, and it was the test that was wrong, not the freeze.

## Law 7 — the wall cannot name an original

The return type of `wall_photos`, read from the catalogue rather than from the source:

```
p_event_slug, p_limit, id, kind, thumb_path, created_at
```

`storage_path` is **not in it**. The wall cannot serve an 840KB original even by mistake, because it has no
column in which to name one. Paired with the constraint from `0008` that a photo cannot reach `ready` without a
thumbnail, there is no path by which a wall query reaches a full-size file.

## Feature D — the cap is money, not a count

`ai_budget_usd` was set to $0.10 and three generations estimated at $0.04 each were requested:

| Call | Cumulative | Allowed |
|---|---|---|
| 1 | $0.04 | **yes** |
| 2 | $0.08 | **yes** |
| 3 | $0.12 | **no** |

The third is refused **before** the paid call, in the same atomic statement that books the spend, so two workers
cannot both pass the check. `settle_generation` afterwards swaps the reserved estimate for the real cost, so the
meter reads money spent rather than money reserved — adding the actual cost without releasing the estimate would
have counted every generation twice.
