// DRIVES: tests/gate/phase-1/static-server.mjs serving dist-test — the real built PWA and the
// real service worker. No mock is involved in what this file proves.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// SHOULD-FIX — WHAT A DEPLOY CAN AND CANNOT REACH.
//
// The service worker used one constant cache name, `laqta-shell-v1`, and `activate` deleted
// only caches whose name differed from it. Since the name never differed, nothing was ever
// deleted. Two consequences, and the second is the one that matters:
//
//   1. Any asset whose URL does not change between builds — the manifest, the icon, anything
//      added to public/ — was served from cache forever. A deploy could not reach an installed
//      station for those, at all, ever.
//
//   2. Every deploy ADDED its bundles to a cache nothing pruned. That reads as untidy until you
//      remember what else lives in this origin's storage: the outbox. Browsers evict a whole
//      origin under storage pressure, so an unbounded cache is a slow leak pointed straight at
//      law 1 — and it fires on the night a station has been through twenty deploys.
//
// The shell is now named after a digest of what it references, so a new build is a new cache
// and every older one is deleted. The MODEL is deliberately not versioned with it: seventy
// megabytes of content-addressed shards re-downloading on a venue uplink because a button
// colour changed would be its own outage.

const DIST = new URL("../../../dist-test/", import.meta.url).pathname;

/** A deploy, as the browser sees one: the worker's own bytes change, so it installs and
 *  activates for real. `registration.update()` on identical bytes is a no-op — the browser
 *  keeps the running worker — so a test that used it would prove nothing about activate. */
async function redeployWorker(page: Page) {
  appendFileSync(`${DIST}sw.js`, `\n// deploy ${Date.now()}\n`);
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.update();
  });
}

async function ready(page: Page) {
  await page.goto("/#/");
  await page.waitForFunction(
    () => navigator.serviceWorker && navigator.serviceWorker.controller !== null,
    undefined, { timeout: 30_000 },
  );
}

const cacheNames = (page: Page) => page.evaluate(() => caches.keys());

test("the shell cache is named for its contents, and old ones do not accumulate", async ({ page }) => {
  const worker = readFileSync(`${DIST}sw.js`, "utf8");
  try {
  await ready(page);

  const before = await cacheNames(page);
  const shells = before.filter((k) => k.startsWith("laqta-shell-"));
  expect(shells.length, "exactly one shell is live").toBe(1);
  expect(shells[0], "and it is versioned, not a constant")
    .not.toBe("laqta-shell-v1");
  expect(shells[0]).toMatch(/^laqta-shell-[0-9a-f]{16}$/);

  // A shell left behind by an earlier deploy. Under the old worker this survived forever.
  await page.evaluate(async () => {
    const junk = await caches.open("laqta-shell-0000000000000000");
    await junk.put("/stale-bundle.js", new Response("old"));
  });
  expect(await cacheNames(page)).toContain("laqta-shell-0000000000000000");

  // A real deploy runs install and activate again; activate prunes.
  await redeployWorker(page);
  await expect
    .poll(async () => (await cacheNames(page)).filter((k) => k.startsWith("laqta-shell-")).length,
      { timeout: 30_000, intervals: [500] })
    .toBe(1);

  const after = await cacheNames(page);
  expect(after, "the stale shell is gone").not.toContain("laqta-shell-0000000000000000");
  expect(after, "and the live one stayed").toContain(shells[0]);
  } finally { writeFileSync(`${DIST}sw.js`, worker); }
});

test("the model cache survives a shell version change", async ({ page }) => {
  const worker = readFileSync(`${DIST}sw.js`, "utf8");
  try {
  await ready(page);

  // Stand in for the model: same path shape, a fraction of the bytes.
  await page.evaluate(async () => {
    const assets = await caches.open("laqta-assets");
    await assets.put("/models/deadbeef", new Response("model-shard"));
  });

  await redeployWorker(page);
  await page.waitForTimeout(3000);

  const kept = await page.evaluate(async () => {
    const assets = await caches.open("laqta-assets");
    const hit = await assets.match("/models/deadbeef");
    return hit ? await hit.text() : null;
  });
  expect(kept, "seventy megabytes are not re-downloaded because a bundle hash moved")
    .toBe("model-shard");
  } finally { writeFileSync(`${DIST}sw.js`, worker); }
});

test("a changed asset at an unchanged URL reaches the station, and offline still opens",
  async ({ page, context }) => {
    const manifestPath = `${DIST}manifest.webmanifest`;
    const original = readFileSync(manifestPath, "utf8");
    try {
      await ready(page);

      // Warm the cache with the shipped manifest.
      const first = await page.evaluate(() => fetch("./manifest.webmanifest").then((r) => r.text()));
      expect(first).toContain("LAQTA");

      // A deploy changes it. Under the old worker the station never saw this again.
      writeFileSync(manifestPath, original.replace(/"name"\s*:\s*"[^"]*"/, '"name": "LAQTA REDEPLOYED"'));

      // Stale-while-revalidate: the station is never made to wait, and converges on the next
      // read. Both halves matter — a network-first worker would hang a booth on a dying uplink.
      await page.evaluate(() => fetch("./manifest.webmanifest").then((r) => r.text()));
      await expect
        .poll(async () => page.evaluate(() => fetch("./manifest.webmanifest").then((r) => r.text())),
          { timeout: 20_000, intervals: [500] })
        .toContain("REDEPLOYED");

      // And the whole point of the cache still holds: with the network gone, the app opens.
      await context.setOffline(true);
      await page.goto("/#/operator/login");
      await expect(page.locator("h1"), "a station power-cycled in the dark still opens")
        .toBeVisible({ timeout: 20_000 });
      await context.setOffline(false);
    } finally {
      writeFileSync(manifestPath, original);
    }
  });
