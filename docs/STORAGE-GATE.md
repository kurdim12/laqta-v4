# The storage gate — the one test only you can run

Everything else in this build is proven. This is the one thing that cannot be: **no photo has
ever actually travelled through the deployed system.** The database is exercised heavily and the
client is exercised heavily, but the twenty lines that carry the image bytes — a signed upload
URL, the PUT from the tablet, the signed read the wall uses — have run zero times in production,
because this build machine is not allowed to reach the project's own address.

So you are the gate. It is four taps.

## Before you start

- The site is on a web address (checklist step 1).
- You are signed in at `#/booth` as `booth1` on the **rehearsal** event.

## The four steps

1. **Take one photo** at `#/booth`. Watch the "Waiting to send" count: it should appear and then
   disappear within a few seconds.
2. **Approve it** at `#/queue`. It moves from Waiting to Approved.
3. **Open the wall** at `#/wall/rehearsal`. The photo should be on it.
4. **Open your photos.** Tap **Code** on that shot in the booth, then scan the QR with your
   phone. The gallery opens and **Download** gives you the full-size picture.

If all four work, the storage path is proven and the dress rehearsal is worth running.

## If any step fails

Do not try to interpret it. Do this instead:

1. On the tablet, open **`#/diag`**.
2. Tap **Copy details** (or take a screenshot of the whole screen).
3. Send me that text or picture.

That screen reads the tablet's own queue, so it tells the truth even with no internet. It shows
the device id, whether the tablet thinks it is online, how many photos are waiting, and the exact
error for each — which is the difference between "something went wrong" and a fix.

Failures also report themselves: a photo that fails twice for a reason the network does not
explain sends a note to the control room, so `#/control` shows it under Activity even if nobody
was watching the tablet.

## What I already fixed in advance

Two things were likely to break this test for reasons that had nothing to do with your event:

- **iPhone photos.** iPhones shoot HEIC; the storage buckets accept only JPEG, PNG and WebP, so
  an iPhone photo would have been refused forever, retrying quietly. Every capture is now
  converted before it is ever queued.
- **The retry-after-a-half-upload case.** Supabase reports "this file already exists" in a shape
  the code did not recognise, which would have turned a successful retry into a permanent
  failure. Both shapes are now read as success.

Neither is proven until your shot goes through. That is what this gate is for.
