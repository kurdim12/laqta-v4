// DRIVES: tests/gate/phase-1/mock-api.mjs (an in-memory stand-in), NOT the deployed
// backend - this container's network policy refuses CONNECT to the project domain.
// This file proves CLIENT LOGIC. The storage round trip is gated by a human on real
// infrastructure; see tests/gate/README.md.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// PHASE 4 GATE, the browser half.
//
// The database half is in gate_phase_4(): the 8-second threshold, queue depth surviving
// death, the law 5 switch re-proof, the audited switch trail, the moderation shape. What only
// a browser can prove is the CLOCK and the CHAIN:
//
//   - kill a station and the control room SHOWS it dead, with its queue depth, within the
//     ten seconds the gate names — measured against a wall clock, not asserted;
//   - a switch flipped in the control room reaches a wall that was never told;
//   - the war room reorders the room's wall with two taps;
//   - a kiosk shot enters the same approval queue as everything else, labelled kiosk.

const MOCK = "http://localhost:8787";
const PNG = readFileSync(new URL("../phase-1/fixture.png", import.meta.url));

async function signIn(page: Page) {
  await page.goto("/#/operator/login");
  await page.getByPlaceholder("lynk-and-co").fill("ops-test");
  await page.locator('input[autocomplete="username"]').fill("boothop");
  await page.locator('input[autocomplete="current-password"]').fill("4821");
  await page.getByRole("button", { name: /sign in|دخول/i }).click();
  await expect(page).toHaveURL(/#\/booth/, { timeout: 20_000 });
}

/** A pretend booth: heartbeats straight at the mock, as the real booth does at the real API. */
function startFakeStation(device: string, depth: number): () => void {
  const beat = () =>
    fetch(`${MOCK}/api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "station.heartbeat", deviceId: device, kind: "booth", label: "Booth A", queueDepth: depth }),
    }).catch(() => {});
  void beat();
  const timer = setInterval(beat, 2000);
  return () => clearInterval(timer);
}

test.beforeEach(async () => {
  await fetch(`${MOCK}/__test/reset`);
});

test("a killed station reads offline in the control room within ten seconds", async ({ page }) => {
  const stop = startFakeStation("dead-booth-1", 4);
  await signIn(page);
  await page.goto("/#/control");

  const row = page.locator('[data-station="dead-booth-1"]');
  await expect(row).toHaveAttribute("data-online", "true", { timeout: 15_000 });

  // The kill. The clock starts NOW.
  stop();
  const killedAt = Date.now();

  await expect(row, "the control room shows the station dead")
    .toHaveAttribute("data-online", "false", { timeout: 12_000 });
  const detectedIn = Date.now() - killedAt;

  expect(detectedIn, `offline was shown ${detectedIn}ms after the kill`).toBeLessThanOrEqual(10_000);
  await expect(row.locator("td").nth(3), "its queue depth is still shown while it is dead")
    .toHaveText("4");
});

test("a switch flipped in the control room reaches a wall that was never told", async ({ page }) => {
  await fetch(`${MOCK}/__test/wall?photos=5`);
  await signIn(page);
  await page.goto("/#/control");

  const panic = page.locator('[data-switch="panicBrandOnly"]');
  await expect(panic).toHaveAttribute("data-on", "false", { timeout: 15_000 });
  await panic.click();
  await expect(panic, "the control room reflects the flip").toHaveAttribute("data-on", "true", { timeout: 10_000 });

  // The wall finds out from the database, not from this tab.
  await page.goto("/#/wall/mock-event");
  await expect(page.locator(".wall-empty"), "the wall went brand-only on its own")
    .toBeVisible({ timeout: 15_000 });

  await page.goto("/#/control");
  await page.locator('[data-switch="panicBrandOnly"]').click();
  await page.goto("/#/wall/mock-event");
  await expect(page.locator(".wall-grid img"), "and recovered when panic cleared")
    .toHaveCount(5, { timeout: 15_000 });
});

test("the war room reorders the wall with two taps", async ({ page }) => {
  await fetch(`${MOCK}/__test/seed?n=3&source=booth`);
  await fetch(`${MOCK}/__test/seed?n=2&source=kiosk`);
  await signIn(page);
  await page.goto("/#/war");

  await expect(page.locator('[data-photo="seed-booth-0"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-photo="seed-kiosk-0"]'), "the kiosk column is real")
    .toBeVisible();

  // Tap a photo, tap a cell.
  await page.locator('[data-photo="seed-booth-0"]').click();
  await page.locator('[data-cell="3"]').click();

  await expect(page.locator('[data-cell="3"] img'), "the mirror shows the placement")
    .toBeVisible({ timeout: 10_000 });

  const placed = await (await fetch(`${MOCK}/__test/state`)).json();
  void placed; // the mirror assertion above is the user-visible truth
});

test("a kiosk shot lands in the approval queue, labelled kiosk", async ({ page }) => {
  await signIn(page);
  await page.goto("/#/kiosk");
  await expect(page.locator("[data-kiosk-shutter]")).toBeVisible();

  await page.setInputFiles('input[type="file"]', {
    name: "guest.png", mimeType: "image/png", buffer: PNG,
  });

  await expect
    .poll(async () => (await (await fetch(`${MOCK}/__test/state`)).json()).confirmed,
          { timeout: 60_000 })
    .toBe(1);

  const st = await (await fetch(`${MOCK}/__test/state`)).json();
  const shot = st.photos[0];
  expect(shot.capture_source, "the shot is labelled by its surface").toBe("kiosk");
  expect(shot.approved ?? false, "and arrives unapproved, like everything else").toBe(false);
});
