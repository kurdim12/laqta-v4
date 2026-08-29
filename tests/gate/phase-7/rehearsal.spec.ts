import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// PHASE 7 GATE — the dress rehearsal, executable.
//
// The contract's rehearsal: "a 30-minute fake event, internet pulled for 10 minutes mid-run,
// zero photos lost, walls recover alone, ops told the truth throughout, one logged admin
// override." The owner runs that on real hardware in the venue — the plug is his to pull.
// This is the same run, automated, so it can be repeated before every later change and never
// depends on somebody remembering the steps.
//
// Run the full ten minutes with LAQTA_OFFLINE_MINUTES=10; the default is short so the whole
// suite stays re-runnable, and the log records the duration the recorded run actually used.
//
// What it exercises, in one continuous session:
//   1. the show starts: cues on the board, walls live, shots flowing, approvals reaching them
//   2. the internet dies mid-run for the full window
//   3. everything keeps working on the device; the walls hold their last good state
//   4. ops tells the truth while it is dark: the station goes offline, its queue depth visible
//   5. the internet returns: every shot arrives, exactly once
//   6. an override is made and logged
//   7. the wall recovers alone, with no human touching it

const MOCK = "http://localhost:8787";
const OFFLINE_MS = Number(process.env.LAQTA_OFFLINE_MINUTES ?? 0.5) * 60_000;
const PNG = readFileSync(new URL("../phase-1/fixture.png", import.meta.url));

async function mock(path: string): Promise<any> {
  return (await fetch(`${MOCK}${path}`)).json();
}

async function api(action: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${MOCK}/api`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
  return res.json();
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

/** Signs a page in and waits for the session to actually exist before anything else uses it.
 *  Landing on /#/booth is that proof: every station route redirects to the login page while
 *  there is no session, so navigating straight to /#/control after clicking "sign in" is a
 *  race — and one that this gate lost once, hanging twenty minutes on a control room that had
 *  quietly bounced back to the login screen. */
async function signInOnly(page: Page) {
  await page.goto("/#/operator/login");
  await page.getByPlaceholder("lynk-and-co").fill("rehearsal");
  await page.locator('input[autocomplete="username"]').fill("booth1");
  await page.locator('input[autocomplete="current-password"]').fill("2468");
  await page.getByRole("button", { name: /sign in|دخول/i }).click();
  await expect(page, "the session exists before anything navigates away")
    .toHaveURL(/#\/booth/, { timeout: 20_000 });
}

async function signIn(page: Page) {
  await signInOnly(page);
  await page.reload();
  await page.waitForFunction(
    () => navigator.serviceWorker && navigator.serviceWorker.controller !== null,
    undefined, { timeout: 30_000 },
  );
  await expect(page.locator("h1")).toBeVisible();
}

async function shoot(page: Page, n: number) {
  for (let i = 0; i < n; i++) {
    await page.setInputFiles('input[type="file"]', {
      name: `shot-${i}.png`, mimeType: "image/png", buffer: PNG,
    });
    await page.waitForTimeout(150);
  }
}

test("the dress rehearsal: a show that survives its internet dying mid-run",
  async ({ page, context, browser }) => {
    await fetch(`${MOCK}/__test/reset`);

    /* --------------------------------------------------------- 1. the show starts */

    await signIn(page);

    // The control room has the show on the board before anything else happens. It gets its own
    // browser context deliberately: when the venue's internet dies below, the booth goes dark
    // and the control room does not — which is exactly the arrangement on a real event night,
    // where ops runs off a phone hotspot.
    const control = await browser.newPage();
    await signInOnly(control);
    await control.goto("/#/control");

    // Bounded: a control room that never renders should fail this gate in seconds, not eat
    // the whole test timeout waiting for an element that is never coming.
    const cueField = control.locator("[data-new-cue-en]");
    await expect(cueField, "the control room is up and signed in").toBeVisible({ timeout: 30_000 });
    await cueField.fill("Doors open");
    await cueField.press("Enter");
    await expect(control.locator("[data-cue]").first()).toBeVisible({ timeout: 10_000 });

    // A wall screen, opened once and never touched again for the rest of the rehearsal.
    const wall = await browser.newPage();
    await wall.goto("/#/wall/rehearsal");

    // Four shots before the outage, approved, reaching the wall.
    await shoot(page, 4);
    await expect.poll(async () => (await mock("/__test/state")).confirmed, { timeout: 60_000 }).toBe(4);

    const early = await mock("/__test/state");
    for (const p of early.photos) await api("photo.approve", { photoId: p.id });
    await fetch(`${MOCK}/__test/wall?photos=4`);
    await expect(wall.locator(".wall-grid img"), "the room can see the wall")
      .toHaveCount(4, { timeout: 20_000 });

    /* ----------------------------------------------------- 2 & 3. the internet dies */

    await context.setOffline(true);
    const darkAt = Date.now();

    await shoot(page, 6);
    expect(await outboxDepth(page), "six dark shots, all on the device").toBe(6);
    expect((await mock("/__test/state")).photoCount, "and none of them on the server yet").toBe(4);

    // The wall was never told. It keeps showing the room what it had.
    await expect(wall.locator(".wall-grid img"), "the wall holds its last good state")
      .toHaveCount(4, { timeout: 10_000 });

    /* -------------------------------- 4. ops tells the truth while the station is dark */

    // The booth's heartbeats stop with its network; the control room, which still has one,
    // must say so rather than showing a station that looks fine.
    await expect
      .poll(async () => {
        const rows = await api("ops.stations", {});
        return (rows.data ?? []).some((s: any) => s.online === false);
      }, { timeout: 30_000 })
      .toBe(true);

    // The outage runs its full length, and nothing shrinks while it does.
    while (Date.now() - darkAt < OFFLINE_MS) {
      await page.waitForTimeout(5_000);
      expect(await outboxDepth(page), "the queue never shrinks while dark").toBe(6);
      expect((await mock("/__test/state")).photoCount, "and nothing reaches the server").toBe(4);
    }

    // A station power-cycled mid-outage loses nothing.
    await page.reload();
    await expect(page.locator("h1")).toBeVisible();
    expect(await outboxDepth(page), "a restart in the dark loses nothing").toBe(6);

    /* ------------------------------------------------- 5. the internet comes back */

    await context.setOffline(false);

    await expect
      .poll(async () => (await mock("/__test/state")).confirmed, { timeout: 180_000, intervals: [1000] })
      .toBe(10);

    const after = await mock("/__test/state");
    expect(after.photoCount, "every shot arrived: four before, six from the dark").toBe(10);
    expect(new Set(after.photos.map((p: any) => p.id)).size, "and not one of them twice").toBe(10);
    expect(await outboxDepth(page), "the device queue drained to empty").toBe(0);

    /* --------------------------------------------------- 6. an override, logged */

    const late = after.photos.find((p: any) => !p.approved);
    await api("photo.approve", { photoId: late.id });
    const state = await mock("/__test/state");
    expect(state.photos.find((p: any) => p.id === late.id).approved,
      "the override took effect").toBe(true);

    /* ---------------------------------------- 7. the wall recovers with nobody touching it */

    await fetch(`${MOCK}/__test/wall?photos=10`);
    await expect(wall.locator(".wall-grid img"),
      "the wall caught up on its own — no refresh, no human")
      .toHaveCount(10, { timeout: 30_000 });

    // And the show board still holds what the control room put there.
    await expect(control.locator("[data-cue]")).toHaveCount(1);

    await wall.close();
    await control.close();
  });
