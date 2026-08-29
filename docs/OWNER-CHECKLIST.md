# The owner's list — everything that genuinely needs your hands

Four items. Every one is browser-only, and none of them takes more than two minutes.
Nothing here is required for the system to work — the build runs today with all four
outstanding, in honest fallback where a piece is missing. They are here because each one
switches on something extra, and because you are the only person who can do them.

They are in the order I would do them.

---

## 1. Put the app on a web address (≈ 2 minutes)

You have three files from me: `laqta-v3-app.zip` and two `laqta-v3-models-*.zip`.

1. Unzip **laqta-v3-app.zip**. You get a folder with `index.html`, `assets`, `sw.js` and a few
   others.
2. Unzip **both models zips into that same folder**, so it also contains a `models` folder.
   (Skip this and everything still works — the wall just shows plain photos instead of
   cut-out figures.)
3. Go to **Cloudflare Pages → Create → Upload assets**, or your Hostinger file manager's
   `public_html`.
4. Drag **the contents of the folder** — not the folder itself. The upload should start with
   `index.html` at the top level.
5. Open the address it gives you. You should see the LAQTA home screen with the station cards.

That address plus a `#/...` ending is every station's URL. They are all listed in
`RUNBOOK.md`, and the printable QR kit at `#/qr/<event>` turns them into codes you can stand
on a table.

## 2. Add the OpenRouter key — turns on paid AI restyles (≈ 2 minutes)

Right now every restyle finishes as the branded original: the system asks for a generation,
finds no key, refunds its own budget reservation to the cent, and publishes the original. The
guest never sees an error. This is the designed fallback, not a fault.

1. Open **supabase.com** → your project **maranasi-laqta-v3**.
2. Left sidebar: **Project Settings → Edge Functions → Secrets**.
3. **Add new secret.** Name: `OPENROUTER_API_KEY`. Value: your key from openrouter.ai.
4. Save.

Nothing to redeploy. The next restyle uses it. The control room's "configured" pill for
OpenRouter turns on by itself.

**Money note:** the moment this key exists, restyles cost real money — capped per event by
the budget and generation limits you set in the admin console. The cap is charged *before*
each call, so an event cannot go over budget having done the work.

## 3. Add the Anam key — turns on the live avatar host (≈ 2 minutes)

The avatar kiosk works today: branded bilingual greeting, working camera, shots landing in the
same approval queue. What it does not have is the talking host. The kiosk asks every minute
whether the key exists, so:

1. Same place: **Project Settings → Edge Functions → Secrets**.
2. **Add new secret.** Name: `ANAM_API_KEY`. Value: your key from anam.ai.
3. Save.

The kiosk climbs to its live mode on its own — no redeploy, no reopening the app. Its staff
corner will read "Live avatar ready" instead of "Avatar offline — photo mode".

## 4. The dress rehearsal — the last thing before the freeze (30 minutes)

I have run the rehearsal end to end as an automated test, including the full ten-minute
outage, and it passes. What I cannot do is run it on **your** hardware in a **real venue**,
and that is exactly the failure v1 died from. So this one is yours.

Set aside 30 minutes with the real tablets, the real screens and the real wifi:

1. Open every station and every wall. Take shots for ten minutes; approve some, reject some.
2. **Pull the venue's internet out** — the router, physically — and leave it out for ten
   minutes. Keep shooting the whole time. Do not close or reload anything.
3. While it is dark, look at the control room (which needs its own connection — a phone
   hotspot is fine): it should show the stations as offline, each with its queue depth.
4. Plug the internet back in. Watch the counts arrive.
5. Check three things at the end:
   - **every photo you took is there, and none of them twice**
   - **the walls came back on their own** — you did not refresh anything
   - **the control room told you the truth throughout**
6. Make one override from the admin console (hide or delete a photo) and check it appears in
   the overrides list.

If all of that holds, the architecture is frozen (law 14): no new features, no new
dependencies, no architecture changes — only fixes, each of which re-runs the whole gate
suite. If something does not hold, that is exactly what a rehearsal is for; tell me what you
saw and it gets fixed before the freeze.

---

## What you never have to do

- Open a terminal, use git, or run a command. Not once, ever.
- Handle the service-role key or any database credential — those live only inside Supabase.
- Redeploy after adding a secret. Every surface checks its own configuration and adapts.
- Worry about a photo during an outage. The photo is on the device before anything is
  attempted, and the device retries forever.
