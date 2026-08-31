// DRIVES: tests/gate/phase-1/mock-api.mjs (an in-memory stand-in), NOT the deployed
// backend - this container's network policy refuses CONNECT to the project domain.
// This file proves CLIENT LOGIC. The database half of the same claim is asserted against
// the live project by run_all_gates(); see tests/gate/README.md.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// OUTCOME GATE 2 — QUEUE-DEPTH TRUTH.
//
// The architect's wording: "a killed kiosk shows its own truth in ops — real depth, honest
// staleness, never a frozen value."
//
// That is three claims, and they fail in three different places:
//
//   1. REAL DEPTH. The heartbeat has to carry the number of photos actually on the device.
//      It did not. Every kiosk surface read its queue depth out of a React state variable
//      captured when the heartbeat interval was created, so the closure held the depth at
//      mount — zero — forever. A kiosk holding forty photos told ops "0 waiting", cheerfully,
//      every ten seconds. The screen was right and the wire was wrong, which is the worst
//      arrangement: the person at the kiosk can see the truth and the person who has to act
//      on it cannot.
//
//   2. HONEST STALENESS. A dead station's depth is the last thing it managed to say, not what
//      it is holding now. Rendering it as a bare number claims currency the row does not have.
//      "0" is the most dangerous of those, because it reads as "nothing waiting" when the
//      truth is that nobody knows.
//
//   3. NEVER FROZEN. The number has to follow reality back down, or ops learns to ignore it.
//
// The outage here spares the heartbeat deliberately: a station's photo uploads can be stuck
// for minutes on a weak uplink while its 200-byte heartbeat still gets out. That is exactly
// when "online, 0 waiting" is a lie a control room acts on.

const MOCK = "http://localhost:8787";
const PNG = readFileSync(new URL("../phase-1/fixture.png", import.meta.url));

async function state(): Promise<any> {
  return (await fetch(`${MOCK}/__test/state`)).json();
}

async function signIn(page: Page) {
  await page.goto("/#/operator/login");
  await page.getByPlaceholder("lynk-and-co").fill("depth");
  await page.locator('input[autocomplete="username"]').fill("kiosk1");
  // Any PIN: the mock's operator.login accepts anything, and a real one here would publish a
  // live credential in a public repository while proving nothing.
  await page.locator('input[autocomplete="current-password"]').fill("000000");
  await page.getByRole("button", { name: /sign in|دخول/i }).click();
  await expect(page, "the session exists before anything navigates away")
    .toHaveURL(/#\/booth/, { timeout: 20_000 });
}

async function shoot(page: Page, n: number) {
  for (let i = 0; i < n; i++) {
    await page.setInputFiles('input[type="file"]', {
      name: `k-${i}.png`, mimeType: "image/png", buffer: PNG,
    });
    await page.waitForTimeout(200);
  }
}

/** What the kiosk last TOLD the server, as it told it. Distinct from what any screen renders:
 *  the bug this gate exists for was a correct screen sending a wrong wire. */
async function reportedDepth(): Promise<number | null> {
  const rows = (await state()).stations ?? [];
  const kiosk = rows.find((s: any) => s.kind === "kiosk");
  return kiosk ? kiosk.depth : null;
}

test.beforeEach(async () => { await fetch(`${MOCK}/__test/reset`); });

test("a kiosk holding photos reports the real number, and ops shows it", async ({ page, browser }) => {
  await signIn(page);
  await page.goto("/#/kiosk");
  await expect(page.locator("[data-kiosk-shutter]")).toBeVisible({ timeout: 20_000 });

  // The control room comes up first and on its own connection, the way it does on a real
  // night — ops runs off a hotspot precisely so it can still see when the floor cannot.
  const control = await browser.newPage();
  await signIn(control);
  await control.goto("/#/control");
  const row = control.locator('tr[data-station]').filter({ hasText: "kiosk" });
  await expect(row).toHaveAttribute("data-online", "true", { timeout: 30_000 });

  // Now the kiosk's photo path dies. Its heartbeat, and everything ops reads, still gets out.
  await fetch(`${MOCK}/__test/outage?ms=120000&scope=photos`);
  await shoot(page, 6);

  // 1. REAL DEPTH — on the wire, not on the screen. This is the assertion the stale closure
  //    failed: it reported 0 while the device held six.
  await expect
    .poll(reportedDepth, { timeout: 30_000, intervals: [1000] })
    .toBe(6);

  // And ops, reading that heartbeat, shows six rather than nothing.
  await expect(row.locator("[data-station-depth]")).toHaveAttribute("data-station-depth", "6",
    { timeout: 30_000 });

  // While the station is still reporting, the depth is a live fact and carries no qualifier.
  await expect(row.locator("[data-station-stale]"),
    "a station we are hearing from needs no as-of").toHaveCount(0);

  /* ------------------------------------------- 2. HONEST STALENESS: kill the kiosk outright */

  // The tablet is unplugged; heartbeats stop. Its storage is held, not destroyed — closing a
  // page keeps the browser context, which is where the outbox and the device id live, so the
  // revived tab below is the SAME tablet coming back rather than a new one.
  const tablet = page.context();
  await page.close();

  await expect(row, "ops notices within the offline threshold")
    .toHaveAttribute("data-online", "false", { timeout: 20_000 });

  // The last known depth is still shown — ops needs to know six photos are sitting on a dead
  // tablet — but never as a live number.
  await expect(row.locator("[data-station-depth]")).toHaveAttribute("data-station-depth", "6");
  await expect(row.locator("[data-station-stale]"),
    "an offline row states when its number was true").toHaveCount(1);
  await expect(row.locator("[data-station-stale]")).toContainText(/as of|منذ/);

  /* ----------------------------------- 3. NEVER FROZEN: the number follows reality back down */

  await fetch(`${MOCK}/__test/outage?ms=0`);
  const revived = await tablet.newPage();
  await revived.goto("/#/kiosk");
  await expect(revived.locator("[data-kiosk-shutter]")).toBeVisible({ timeout: 20_000 });

  // The six photos drain, and the wire says so.
  await expect.poll(async () => (await state()).confirmed, { timeout: 90_000, intervals: [1000] }).toBe(6);
  await expect.poll(reportedDepth, { timeout: 30_000, intervals: [1000] }).toBe(0);

  await expect(row.locator("[data-station-depth]")).toHaveAttribute("data-station-depth", "0",
    { timeout: 30_000 });
  await expect(row, "and the station is live again").toHaveAttribute("data-online", "true");
  await expect(row.locator("[data-station-stale]"),
    "a zero we are actually hearing is a fact, not a guess").toHaveCount(0);

  await revived.close();
  await control.close();
});

test("an offline station's zero is never presented as a live zero", async ({ page, browser }) => {
  // The subtler half of claim 2. A kiosk that goes dark with an EMPTY queue reports 0, and
  // then may shoot forty photos in the dark. Ops still holds that 0. Shown bare, it says
  // "nothing waiting"; the honest reading is "0, as of four minutes ago".
  await signIn(page);
  await page.goto("/#/kiosk");
  await expect(page.locator("[data-kiosk-shutter]")).toBeVisible({ timeout: 20_000 });

  const control = await browser.newPage();
  await signIn(control);
  await control.goto("/#/control");
  const row = control.locator('tr[data-station]').filter({ hasText: "kiosk" });
  await expect(row).toHaveAttribute("data-online", "true", { timeout: 30_000 });
  await expect(row.locator("[data-station-depth]")).toHaveAttribute("data-station-depth", "0");
  await expect(row.locator("[data-station-stale]")).toHaveCount(0);

  await page.close();

  await expect(row).toHaveAttribute("data-online", "false", { timeout: 20_000 });
  await expect(row.locator("[data-station-depth]"),
    "the zero is still the last thing we heard").toHaveAttribute("data-station-depth", "0");
  await expect(row.locator("[data-station-stale]"),
    "but it is dated, so nobody reads it as 'nothing waiting'").toHaveCount(1);

  await control.close();
});
