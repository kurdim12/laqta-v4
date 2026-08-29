import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// PHASE 3 GATE, the browser half — law 2 where it actually runs.
//
// The database half (queue, lease, cap-before-spend, settle, the recorded 95-second run on
// the production runtime) lives in gate_phase_3(). What only a browser can prove is here:
//
//   - the background-removal model that SHIPS WITH THE APP actually produces a cutout, with
//     no third-party fetch anywhere in the path, and
//   - when the model cannot be reached at all, the hard timeout and automatic fallback mean
//     the capture pipeline completes untouched — the photo publishes, nothing blocks, and
//     "use original" happens by itself.

const MOCK = "http://localhost:8787";
const PNG = readFileSync(new URL("../phase-1/fixture.png", import.meta.url));

async function state(): Promise<any> {
  return (await fetch(`${MOCK}/__test/state`)).json();
}

async function signIn(page: Page) {
  await page.goto("/#/operator/login");
  await page.getByPlaceholder("lynk-and-co").fill("cutout-test");
  await page.locator('input[autocomplete="username"]').fill("boothop");
  await page.locator('input[autocomplete="current-password"]').fill("4821");
  await page.getByRole("button", { name: /sign in|دخول/i }).click();
  await expect(page).toHaveURL(/#\/booth/, { timeout: 20_000 });
}

test.beforeEach(async () => {
  await fetch(`${MOCK}/__test/reset`);
});

test("the shipped model produces a real cutout, from our own origin only", async ({ page }) => {
  // Only same-origin and mock-server requests are allowed to succeed. A single request to any
  // other host — a CDN reaching for model files — fails the test by name.
  const foreign: string[] = [];
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return route.continue();
    foreign.push(url.href);
    return route.abort();
  });

  await signIn(page);
  await page.setInputFiles('input[type="file"]', {
    name: "guest.png", mimeType: "image/png", buffer: PNG,
  });

  // The photo publishes first — the cutout is enrichment that follows.
  await expect.poll(async () => (await state()).confirmed, { timeout: 60_000 }).toBe(1);

  // The real model run: wasm + 44MB weights, all from ./models/ on our origin.
  await expect
    .poll(async () => (await state()).cutouts.length, { timeout: 180_000, intervals: [2000] })
    .toBe(1);

  const s = await state();
  expect(s.cutoutUploads, "the cutout bytes were uploaded").toBe(1);
  expect(s.cutouts[0][1], "the cutout path was recorded").toContain(".cutout.png");
  expect(foreign, "no request left our origin for the model").toEqual([]);
});

test("an unreachable model degrades to the original, silently and without blocking", async ({ page }) => {
  // The model directory is dead — the exact shape of v1's failure, pointed at ourselves.
  await page.route("**/models/**", (route) => route.abort());

  await signIn(page);
  await page.setInputFiles('input[type="file"]', {
    name: "guest.png", mimeType: "image/png", buffer: PNG,
  });

  // The capture pipeline completes exactly as if cutouts did not exist.
  await expect.poll(async () => (await state()).confirmed, { timeout: 60_000 }).toBe(1);

  // And stays that way: no cutout ever arrives, and nothing hangs waiting for one.
  await page.waitForTimeout(8_000);
  const s = await state();
  expect(s.cutouts.length, "no cutout was recorded").toBe(0);
  expect(s.confirmed, "the photo is published regardless").toBe(1);
  expect(s.photoCount, "exactly one photo, no duplicates from the failed enrichment").toBe(1);
});
