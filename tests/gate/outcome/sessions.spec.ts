// DRIVES: tests/gate/phase-1/mock-api.mjs (an in-memory stand-in), NOT the deployed
// backend - this container's network policy refuses CONNECT to the project domain.
// This file proves CLIENT LOGIC. The deployed function's own session lifetime is asserted
// separately, against the live database, by gate_sessions(); see tests/gate/README.md.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// OUTCOME GATE 3 — SESSION SURVIVAL.
//
// The architect's wording: "yesterday's sign-in survives showtime unattended; expiry during an
// outage cannot strand the outbox."
//
// The failure this closes is not exotic. Stations are set up the evening before an event and
// are expected to work through the following night with nobody logging back in. A twelve-hour
// session expires somewhere around the second guest of a show that started 26 hours after
// setup — and because the expiry lands mid-shoot, it lands on a device that is already holding
// photos. So the two halves of the gate are one story:
//
//   1. SURVIVES. A session issued yesterday is still valid tonight, and using it slides it
//      forward, so a station in use never expires under the person using it.
//
//   2. CANNOT STRAND. If a credential does die — a tablet closed for three days, a rotated PIN
//      mid-show — the photos on that device are not lost and not marked permanently failed.
//      NOT_SIGNED_IN is a transient error the outbox waits on, the drain loop stops rather than
//      burning retries against a wall, and the booth says the one thing a human can act on:
//      sign in again. The queue then drains, exactly once.

const MOCK = "http://localhost:8787";
const PNG = readFileSync(new URL("../phase-1/fixture.png", import.meta.url));

async function state(): Promise<any> {
  return (await fetch(`${MOCK}/__test/state`)).json();
}

async function signIn(page: Page) {
  await page.goto("/#/operator/login");
  await page.getByPlaceholder("lynk-and-co").fill("sessions");
  await page.locator('input[autocomplete="username"]').fill("booth1");
  // Any PIN: the mock's operator.login accepts anything, and a real one here would publish a
  // live credential in a public repository while proving nothing.
  await page.locator('input[autocomplete="current-password"]').fill("000000");
  await page.getByRole("button", { name: /sign in|دخول/i }).click();
  await expect(page).toHaveURL(/#\/booth/, { timeout: 20_000 });
}

/** The expiry the device believes it holds, read from where it actually keeps it. */
async function storedExpiry(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("laqta.session");
    if (!raw) return null;
    const s = JSON.parse(raw);
    return typeof s.exp === "number" ? s.exp : null;
  });
}

async function outboxDepth(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const r = indexedDB.open("laqta", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return new Promise<number>((resolve) => {
      const req = db.transaction("outbox", "readonly").objectStore("outbox").getAll();
      req.onsuccess = () => resolve((req.result as any[]).filter((i) => i.state !== "done").length);
      req.onerror = () => resolve(-1);
    });
  });
}

async function shoot(page: Page, n: number) {
  for (let i = 0; i < n; i++) {
    await page.setInputFiles('input[type="file"]', {
      name: `s-${i}.png`, mimeType: "image/png", buffer: PNG,
    });
    await page.waitForTimeout(200);
  }
}

const HOUR = 3600_000;

test.beforeEach(async () => {
  await fetch(`${MOCK}/__test/reset`);
});

test("yesterday's sign-in is still working tonight, and slides forward as it is used",
  async ({ page }) => {
    // Set up at 6pm the night before; doors are at midnight tonight. Thirty hours ago.
    await fetch(`${MOCK}/__test/session?hours=36&ageHours=30`);

    // What that thirty-hour-old sign-in is actually worth, read from the token itself before
    // any browser touches it. Six hours left — and under the twelve-hour session this system
    // shipped with, it would have expired eighteen hours ago, in the van on the way over.
    const login = await (await fetch(`${MOCK}/api`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "operator.login", username: "booth1" }),
    })).json();
    const issuedExp = JSON.parse(
      Buffer.from(login.data.token.split(".")[0], "base64url").toString("utf8"),
    ).exp as number;
    expect(issuedExp - Date.now(), "yesterday's credential is still live tonight")
      .toBeGreaterThan(0);
    expect(issuedExp - Date.now(), "but on its own it would not see the night out")
      .toBeLessThan(8 * HOUR);

    // Now the station itself. It signs in with that same thirty-hour-old-shaped session and
    // starts working: the booth feed and the heartbeat both call out within a second.
    await signIn(page);

    // And what it ends up HOLDING is not what it was handed. Using a session past its halfway
    // mark returns a fresh one, adopted in the one place every call passes through, so the
    // tablet now has a full night ahead of it with nobody touching it. This is the assertion
    // that fails if the refresh header is not sent, not exposed by CORS, or not adopted —
    // three separate places this has to be right, and it was wrong in one of them.
    await expect
      .poll(async () => {
        const held = await storedExpiry(page);
        return held !== null && held - Date.now() > 24 * HOUR;
      }, { timeout: 30_000, intervals: [500] })
      .toBe(true);

    const held = await storedExpiry(page);
    expect(held! - issuedExp, "the credential it holds outlives the one it was given")
      .toBeGreaterThan(HOUR);

    // Authenticated, and working — the point of being signed in at all.
    await shoot(page, 1);
    await expect.poll(async () => (await state()).confirmed, { timeout: 60_000 }).toBe(1);
  });

test("a session that dies in the dark strands nothing: the photos wait, and say why",
  async ({ page, context }) => {
    await signIn(page);

    // Three shots taken with the venue's internet gone.
    await context.setOffline(true);
    await shoot(page, 3);
    expect(await outboxDepth(page), "three shots, safe on the device").toBe(3);

    // While it is dark, the credential dies — the tablet was signed in days ago, or the PIN
    // was rotated mid-show. The device comes back to a network that refuses it by name.
    await fetch(`${MOCK}/__test/session?hours=36&ageHours=48`);
    await page.evaluate(() => {
      const raw = localStorage.getItem("laqta.session");
      if (!raw) throw new Error("no session to expire");
      const s = JSON.parse(raw);
      s.exp = Date.now() - 1000;
      // The token itself has to be expired too, or the server would still accept it and this
      // would only be testing the client's opinion of its own clock.
      const payload = JSON.parse(atob(s.token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
      payload.exp = Date.now() - 1000;
      const re = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      s.token = `${re}.mock`;
      localStorage.setItem("laqta.session", JSON.stringify(s));
    });
    await context.setOffline(false);

    // NOTHING IS LOST and nothing is burned. The three photos stay queued rather than being
    // marked permanently failed, and the booth says the one thing a person can act on.
    const banner = page.locator("[data-needs-signin]");
    await expect(banner, "the booth asks for a sign-in rather than reporting a mystery")
      .toBeVisible({ timeout: 60_000 });
    await expect(banner).toContainText(/sign in|الدخول|تسجيل/i);

    expect(await outboxDepth(page), "and the photos are exactly where they were").toBe(3);
    expect((await state()).photoCount, "with none of them lost to the server either").toBe(0);

    // A reload does not change that: the queue is on disk, not in a page.
    await page.reload();
    expect(await outboxDepth(page), "a restart while signed out loses nothing").toBe(3);

    // The operator signs in again — the ten-second fix the banner asked for.
    await fetch(`${MOCK}/__test/session?hours=36&ageHours=0`);
    await signIn(page);

    // And the queue drains. Exactly once: three shots in, three photos out.
    await expect
      .poll(async () => (await state()).confirmed, { timeout: 120_000, intervals: [1000] })
      .toBe(3);
    const after = await state();
    expect(new Set(after.photos.map((p: any) => p.id)).size, "and not one of them twice").toBe(3);
    await expect.poll(() => outboxDepth(page), { timeout: 60_000 }).toBe(0);
  });
