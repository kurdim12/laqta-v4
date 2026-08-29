import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// PHASE 1 GATE — the airplane test.
//
// "network killed, 10 shots taken dark, 10+ minutes offline, reconnect → exactly 10 arrive,
//  zero duplicates; restart mid-sync → count never drops."
//
// Run the full ten minutes with LAQTA_OFFLINE_MINUTES=10. The default is short so the suite
// stays re-runnable before every later phase report, which is what law 13 asks for; the gate
// record in docs/RUNNING-LOG.md states the duration the recorded run actually used.

const MOCK = "http://localhost:8787";
const OFFLINE_MS = Number(process.env.LAQTA_OFFLINE_MINUTES ?? 0.5) * 60_000;

// A real, decodable PNG, generated once and committed. The booth makes its thumbnail from
// whatever it is handed, so the fixture has to be something a browser can actually decode —
// the first version of this test used a malformed blob and spent its whole run watching the
// outbox retry a photo that could never be encoded, which is exactly what the outbox should do
// and exactly not what the test meant to measure.
const PNG = readFileSync(new URL("./fixture.png", import.meta.url));

async function mock(path: string): Promise<any> {
  const res = await fetch(`${MOCK}${path}`);
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

/** Waits until the service worker is not merely registered but actually controlling this
 *  page. Until it is, a reload still needs the network, and the test would be measuring the
 *  wrong thing when it cuts the connection. */
async function awaitServiceWorker(page: Page) {
  await page.waitForFunction(
    () => navigator.serviceWorker && navigator.serviceWorker.controller !== null,
    undefined,
    { timeout: 30_000 },
  );
}

async function signIn(page: Page) {
  await page.goto("/#/operator/login");
  await page.getByPlaceholder("lynk-and-co").fill("airplane-test");
  await page.locator('input[autocomplete="username"]').fill("boothop");
  await page.locator('input[autocomplete="current-password"]').fill("4821");
  await page.getByRole("button", { name: /sign in|دخول/i }).click();
  await expect(page).toHaveURL(/#\/booth/, { timeout: 20_000 });

  // The first load installs the worker; one reload puts it in control, which is the state a
  // station is really in by the time an event starts.
  await page.reload();
  await awaitServiceWorker(page);
  await expect(page.locator("h1")).toBeVisible();
}

async function shoot(page: Page, n: number) {
  for (let i = 0; i < n; i++) {
    await page.setInputFiles('input[type="file"]', {
      name: `shot-${i}.png`, mimeType: "image/png", buffer: PNG,
    });
    // Let the shutter write to IndexedDB before the next one.
    await page.waitForTimeout(120);
  }
}

test("ten shots taken dark arrive exactly once, and a restart never loses one", async ({ page, context }) => {
  await fetch(`${MOCK}/__test/reset`);
  await signIn(page);

  // ---------------------------------------------------------------- the venue internet dies
  await context.setOffline(true);

  await shoot(page, 10);

  expect(await outboxDepth(page), "all ten shots are on the device").toBe(10);
  expect((await mock("/__test/state")).photoCount, "nothing reached the server").toBe(0);

  // ------------------------------------------------- a long time passes with no connection
  const started = Date.now();
  while (Date.now() - started < OFFLINE_MS) {
    await page.waitForTimeout(5_000);
    expect(await outboxDepth(page), "the queue never shrinks while offline").toBe(10);
  }

  // -------------------------------------------- the station is power-cycled mid-outage
  await page.reload();
  await expect(page.locator("h1")).toBeVisible();
  expect(await outboxDepth(page), "a restart during the outage loses nothing").toBe(10);
  expect((await mock("/__test/state")).photoCount, "still nothing on the server").toBe(0);

  // ------------------------------------------------------------------- the internet returns
  await context.setOffline(false);

  await expect
    .poll(async () => (await mock("/__test/state")).confirmed, { timeout: 120_000, intervals: [1000] })
    .toBe(10);

  const state = await mock("/__test/state");
  expect(state.photoCount, "exactly ten photos arrived").toBe(10);
  expect(new Set(state.photos.map((p: any) => p.id)).size, "zero duplicates").toBe(10);
  expect(await outboxDepth(page), "the device queue drained to empty").toBe(0);

  // Provenance survived the whole journey: the shutter time, not the arrival time.
  for (const p of state.photos) {
    expect(p.client_captured_at, "the shutter time was kept").toBeTruthy();
    expect(p.device_id, "the device is recorded").toBeTruthy();
  }
});

test("a restart in the middle of syncing never drops the count", async ({ page, context }) => {
  await fetch(`${MOCK}/__test/reset`);
  await signIn(page);

  await context.setOffline(true);
  await shoot(page, 10);
  expect(await outboxDepth(page)).toBe(10);

  // Come back online, but make the server fail for a while, so the drain loop is actively
  // retrying when the station is restarted underneath it.
  await fetch(`${MOCK}/__test/outage?ms=6000`);
  await context.setOffline(false);
  await page.waitForTimeout(2000);

  // Power cut, mid-sync.
  await page.reload();
  await expect(page.locator("h1")).toBeVisible();

  const afterRestart = await outboxDepth(page);
  const arrived = (await mock("/__test/state")).photoCount;
  expect(afterRestart + arrived,
    "every shot is either still on the device or already on the server - never neither").toBe(10);

  await expect
    .poll(async () => (await mock("/__test/state")).confirmed, { timeout: 120_000, intervals: [1000] })
    .toBe(10);

  const state = await mock("/__test/state");
  expect(state.photoCount, "exactly ten, after a mid-sync restart").toBe(10);
  expect(new Set(state.photos.map((p: any) => p.id)).size, "zero duplicates").toBe(10);
  expect(await outboxDepth(page), "and the device is empty").toBe(0);
});
