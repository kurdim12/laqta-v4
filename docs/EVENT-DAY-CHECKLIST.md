# LAQTA v3 — Event-day checklist

One page. Everything here is a tap or a look, in order, on the day. Nothing on this page
needs a terminal, and nothing needs the internet to be working when you start.

Times are relative to doors opening.

---

## First line, every time — is the photo path alive?

- [ ] **Control room → Config health.** The **storage** pill reads green and the line under it
      says the photo round trip was proven minutes ago, not days.

That one pill is the whole capture path: the system uploads a real image to the real bucket,
signs a link, fetches it back and compares the bytes — end to end, on the live project, once an
hour, by itself. Green means a photo taken tonight has somewhere to land. Amber, or a proof
older than a couple of hours, means stop and read the runbook before anybody shoots: nothing
else on this page matters if that is red.

*(It re-runs on its own. There is nothing to press.)*

---

## The night before

- [ ] **Every tablet and screen charged to 100%.** The offline law protects the photos, not
      the battery.
- [ ] **Every station opened once, on the venue's wifi**, and left open long enough to show
      the booth screen. That first open installs the app and its offline shell; a station
      opened for the first time on a dead network is the one thing the system cannot save.
- [ ] **QR kit printed** (`#/qr/<event>` → Print) and the stands laid out.
- [ ] **Crew tasks entered** in the control room, so the floor has one list.

## T-60 — setting up

- [ ] Admin console → the event is **live** (not draft).
- [ ] Branding checked: name in both languages, colours, logo.
- [ ] Guest mode set for tonight: **wall only** · **code per shot** · **registration**.
- [ ] Walls opened, one screen each, and left alone:
      grid `#/wall/<event>` · LED `#/wall/<event>/led` · lightbox `#/wall/<event>/lightbox`
- [ ] Booth tablets signed in (`#/booth`), kiosks armed (`#/kiosk`, `#/shirt`, `#/avatar`).
- [ ] Control room open on the ops laptop (`#/control`), war room on the second screen
      (`#/war`).

## T-15 — the last look before doors

- [ ] **Control room shows every station online**, each with a queue depth of 0.
      A station that is not on that list is a station that is not signed in.
- [ ] **Configured/missing pills read as expected.** Anything missing is a feature running in
      fallback, not a broken system — but know which before doors, not during.
- [ ] Take **one test shot**, approve it, watch it reach a wall. Then delete it.
- [ ] AI spend meter reads 0 and the budget is what you meant it to be.

## During the show

**Every 15 minutes, look at three things:**

1. **Stations** — all online, queue depths near zero. A depth that climbs and stays up means
   that station's network is struggling; the photos are safe, they are just waiting.
2. **Spend meter** — against budget. The cap refuses work before it spends, so an event that
   hits the cap keeps shooting and stops restyling.
3. **Failures (last hour)** — a number that stays flat is a healthy show.

**When a guest asks for their photos:** code-per-shot → the operator taps **Code** on the shot
and turns the tablet. Registration → the guest already has their code; `#/guest` opens it.

## When something goes wrong

| What you see | What to do |
|---|---|
| The wall is showing something it shouldn't | **Panic brand-only** in the control room. The wall goes to branding instantly. Fix, then clear it. |
| The wall must stop changing (a speech, a photo op) | **Freeze wall.** It keeps showing what it has. |
| Too many photos coming in to moderate | **Pause intake.** Stations keep the shots on-device; nothing is lost. |
| Restyles are slow or wrong | **Pause AI.** Photos keep flowing; only the restyling stops. |
| The venue's internet dies | **Do nothing.** Shots keep landing on the devices; walls hold their last state; everything syncs when it returns. Do NOT close or reload a station. |
| A station shows red "needs attention" | That shot cannot be encoded on that device. The photo is not lost — it stays in the queue. Take the shot again and carry on. |
| An operator is locked out | Admin console → unlock. The lockout is deliberate; the unlock is logged. |

## After the show

- [ ] Control room: **freeze the walls** before the room empties, so the last state stays up.
- [ ] Let the queues drain to zero **before** turning stations off. Check the control room.
- [ ] Admin console: set the event to **archived**. Archived is final.
- [ ] Note anything that surprised you. That note is the next event's checklist item.
