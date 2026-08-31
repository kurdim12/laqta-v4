// DRIVES: tests/gate/phase-1/mock-api.mjs (an in-memory stand-in), NOT the deployed
// backend - this container's network policy refuses CONNECT to the project domain.
// This file proves CLIENT LOGIC. See tests/gate/README.md.
//
// The mock serves photo bytes from port 8787 while the app runs on 8788, so the
// cross-origin condition this gate exists for is reproduced faithfully rather than assumed.
import { expect, test, type Page } from "@playwright/test";

// SHOULD-FIX — THE GUEST'S DOWNLOAD.
//
// Feature H promises "guest gallery by code with downloads". The markup carried
// `<a href={signedUrl} download>` since phase 5, and the phase-5 gate asserted that the
// anchor EXISTED — which is exactly the attribute that does nothing here. `download` is
// honoured only for same-origin (and blob:/data:) hrefs, and a photo is always served from
// Supabase Storage, which is never our origin. So the attribute was inert: the tap opened a
// JPEG in a new tab named after a UUID and left the guest to long-press it, and inside an
// in-app browser — where a scanned QR usually lands — that tab can dead-end with no save
// affordance at all.
//
// A gate that asserts an attribute is present is not a gate on the behaviour that attribute
// is supposed to produce. This one clicks the thing and waits for an actual download.

const MOCK = "http://localhost:8787";

async function api(action: string, body: Record<string, unknown>) {
  const res = await fetch(`${MOCK}/api`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
  return res.json();
}

async function signIn(page: Page, slug: string) {
  await page.goto("/#/operator/login");
  await page.getByPlaceholder("lynk-and-co").fill(slug);
  await page.locator('input[autocomplete="username"]').fill("boothop");
  // Any PIN: the mock's operator.login accepts anything, and a real one here would publish a
  // live credential in a public repository while proving nothing.
  await page.locator('input[autocomplete="current-password"]').fill("000000");
  await page.getByRole("button", { name: /sign in|دخول/i }).click();
  await expect(page).toHaveURL(/#\/booth/, { timeout: 20_000 });
}

/** Opens a gallery holding exactly one approved photo, and returns its code. */
async function galleryWithOnePhoto(page: Page): Promise<string> {
  await fetch(`${MOCK}/__test/reset`);
  await fetch(`${MOCK}/__test/mode?slug=dl&mode=code_per_shot`);
  await signIn(page, "dl");
  await fetch(`${MOCK}/__test/seed?n=1&source=booth`);

  const mint = page.locator('[data-mint="seed-booth-0"]');
  await expect(mint).toBeVisible({ timeout: 10_000 });
  await mint.click();
  const code = (await page.locator("[data-code]").getAttribute("data-code"))!;
  await api("photo.approve", { photoId: "seed-booth-0" });

  await page.goto(`/#/guest?code=${code}`);
  await expect(page.locator(".tile img")).toHaveCount(1, { timeout: 10_000 });
  return code;
}

test("tapping download actually saves a file, named for the guest and not for the storage key",
  async ({ page }) => {
    const code = await galleryWithOnePhoto(page);

    const link = page.locator(".tile [data-download]");
    await expect(link, "the anchor is still there as the fallback").toHaveCount(1);

    // The behaviour, not the attribute: a real download event, with real bytes.
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      link.click(),
    ]);

    expect(download.suggestedFilename(),
      "a name the guest recognises in their downloads folder")
      .toBe(`laqta-${code.toLowerCase()}-1.jpg`);

    const path = await download.path();
    expect(path, "and the file is on disk").toBeTruthy();
  });

test("a photo the browser cannot fetch still leaves the guest a working link", async ({ page, context }) => {
  // The fallback that makes this safe to ship: with the bytes unreachable the blob save
  // fails, and the anchor's own href is what the guest is left with — which is precisely the
  // behaviour that shipped before this change. An enhancement that can strand a guest is not
  // an enhancement.
  await galleryWithOnePhoto(page);

  const link = page.locator(".tile [data-download]");
  const href = await link.getAttribute("href");
  expect(href, "the real photo URL is on the element, not only in a handler").toBeTruthy();

  // Kill the BYTES FETCH only — scoped by resource type, so the fallback tab's own navigation
  // to the photo still loads. Aborting everything would break the fallback we are testing and
  // then blame the product for it.
  await context.route("**/thumb/**", (route) => {
    const kind = route.request().resourceType();
    return kind === "fetch" || kind === "xhr" ? route.abort() : route.continue();
  });
  const opened = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
  await link.click();

  // Either a new tab opened on the photo, or the download still fired. What must NOT happen is
  // the tap doing nothing at all and the button staying stuck in its loading state.
  const fallbackTab = await opened;
  if (fallbackTab) expect(fallbackTab.url()).toContain("/thumb/");

  await expect(link.locator("button"), "the button comes back to life either way")
    .toBeEnabled({ timeout: 15_000 });
});
