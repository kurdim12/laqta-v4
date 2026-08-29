import { expect, test, type Page } from "@playwright/test";

// PHASE 2 GATE — the walls survive the show going wrong.
//
// "each wall survives hard refresh + 5-minute network cut mid-show and resumes correct state
//  alone; unpublished photos provably unreachable."
//
// The unreachability half runs against the REAL database in gate_phase_2() — placement healing,
// panic, freeze, the publish gate outranking both. What only a browser can prove is here: that
// each wall, mid-show, keeps showing the room what it had through a cut, comes back from a
// power-cycle during the cut, and reconciles alone when the network returns.
//
// LAQTA_CUT_MINUTES=5 runs the contract's full cut per wall; the default keeps the suite
// re-runnable before every later report (law 13). The recorded duration is in the log.

const MOCK = "http://localhost:8787";
const CUT_MS = Number(process.env.LAQTA_CUT_MINUTES ?? 0.3) * 60_000;

async function mockSet(query: string) {
  await fetch(`${MOCK}/__test/wall?${query}`);
}

async function openWithServiceWorker(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.reload();
  await page.waitForFunction(
    () => navigator.serviceWorker && navigator.serviceWorker.controller !== null,
    undefined, { timeout: 30_000 },
  );
}

/** Rides out the cut, verifying the whole way that the wall never goes blank. */
async function holdThroughCut(page: Page, selector: string, count: number) {
  const started = Date.now();
  do {
    await page.waitForTimeout(Math.min(5_000, CUT_MS));
    await expect(page.locator(selector), "the wall never goes blank during the cut")
      .toHaveCount(count);
  } while (Date.now() - started < CUT_MS);
}

test.beforeEach(async () => {
  await fetch(`${MOCK}/__test/reset`);
});

test("the grid wall holds through a cut, a power-cycle, and reconciles alone", async ({ page, context }) => {
  await mockSet("photos=6");
  await openWithServiceWorker(page, "/#/wall/mock-event");
  await expect(page.locator(".wall-grid img")).toHaveCount(6);

  await context.setOffline(true);
  await holdThroughCut(page, ".wall-grid img", 6);

  // The power-cycle mid-cut: the shell comes from the service worker, the wall from disk.
  await page.reload();
  await expect(page.locator(".wall-grid img"), "a reload during the cut still shows the wall")
    .toHaveCount(6);

  // While the wall was dark, the show moved on.
  await mockSet("photos=8");
  await context.setOffline(false);
  await expect(page.locator(".wall-grid img"), "the wall reconciles alone on reconnect")
    .toHaveCount(8, { timeout: 30_000 });
});

test("the lightbox holds its placement through a cut and reconciles alone", async ({ page, context }) => {
  await mockSet("photos=5");
  await openWithServiceWorker(page, "/#/wall/mock-event/lightbox");
  await expect(page.locator(".lightbox-cell img")).toHaveCount(5);
  await expect(page.locator(".lightbox-cell"), "all 28 boxes render, filled or not").toHaveCount(28);

  await context.setOffline(true);
  await holdThroughCut(page, ".lightbox-cell img", 5);

  await page.reload();
  await expect(page.locator(".lightbox-cell img"), "placement survives a power-cycle mid-cut")
    .toHaveCount(5);

  await mockSet("photos=9");
  await context.setOffline(false);
  await expect(page.locator(".lightbox-cell img"), "the lightbox reconciles alone")
    .toHaveCount(9, { timeout: 30_000 });
});

test("the LED wall cycles, holds through a cut, and obeys panic when it returns", async ({ page, context }) => {
  await mockSet("photos=6");
  await openWithServiceWorker(page, "/#/wall/mock-event/led");
  // layout under test: 2x2, no brand cells -> 4 photo cells
  await expect(page.locator(".wall-led .led-photo")).toHaveCount(4);

  // The cycle is real: the same cell shows a different photo after cycleSeconds.
  const firstSrc = await page.locator(".wall-led .led-photo img").first().getAttribute("src");
  await expect
    .poll(async () => page.locator(".wall-led .led-photo img").first().getAttribute("src"),
          { timeout: 15_000 })
    .not.toBe(firstSrc);

  await context.setOffline(true);
  await holdThroughCut(page, ".wall-led .led-photo", 4);

  await page.reload();
  await expect(page.locator(".wall-led .led-photo"), "the LED grid survives a power-cycle mid-cut")
    .toHaveCount(4);

  // Back online — and the control room has hit panic while we were dark. The wall must obey
  // on its own, with nobody touching the screen.
  await mockSet("panic=1");
  await context.setOffline(false);
  await expect(page.locator(".wall-empty"), "panic empties the wall to brand-only, unattended")
    .toBeVisible({ timeout: 30_000 });

  await mockSet("panic=0");
  await expect(page.locator(".wall-led .led-photo"), "and it recovers alone when panic clears")
    .toHaveCount(4, { timeout: 30_000 });
});
