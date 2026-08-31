// DRIVES: tests/gate/phase-1/mock-api.mjs (an in-memory stand-in), NOT the deployed
// backend - this container's network policy refuses CONNECT to the project domain.
// This file proves CLIENT LOGIC. The storage round trip is gated by a human on real
// infrastructure; see tests/gate/README.md.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// PHASE 5 GATE, the browser half.
//
// The database half is in gate_phase_5(): the mode enforcement (wall_only mints nothing,
// unbound codes cannot exist, registration is charged before it writes), one-shot-one-code,
// the publish gate holding for guests, cross-event guest binding refused. What only a browser
// can prove is each mode's JOURNEY, end to end, on one event without touching another:
//
//   - a wall-only event's guest page offers exactly nothing to type;
//   - code-per-shot: the operator mints at the booth, shows a QR, and the code opens the
//     guest's gallery with a download;
//   - registration: the kiosk registers a guest, binds their shots at the shutter, and the
//     farewell code opens their photos from a scanned link — with WhatsApp and SMS share
//     links carrying a real sending path out of the gallery;
//   - the modes live side by side: three events, three behaviours, zero leakage.

const MOCK = "http://localhost:8787";
const PNG = readFileSync(new URL("../phase-1/fixture.png", import.meta.url));

async function signIn(page: Page, slug: string) {
  await page.goto("/#/operator/login");
  await page.getByPlaceholder("lynk-and-co").fill(slug);
  await page.locator('input[autocomplete="username"]').fill("boothop");
  await page.locator('input[autocomplete="current-password"]').fill("4821");
  await page.getByRole("button", { name: /sign in|دخول/i }).click();
  await expect(page).toHaveURL(/#\/booth/, { timeout: 20_000 });
}

async function setMode(slug: string, mode: string) {
  await fetch(`${MOCK}/__test/mode?slug=${slug}&mode=${mode}`);
}

async function api(action: string, body: Record<string, unknown>) {
  const res = await fetch(`${MOCK}/api`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
  return res.json();
}

test.beforeEach(async () => {
  await fetch(`${MOCK}/__test/reset`);
});

test("a wall-only event's guest page offers the wall and nothing else", async ({ page }) => {
  await setMode("wall-a", "wall_only");
  await page.goto("/#/g/wall-a");

  await expect(page.locator('[data-guest-mode="wall_only"]')).toBeVisible();
  await expect(page.locator("form"), "no form to fill, nothing to register").toHaveCount(0);
  await expect(page.locator("input"), "nothing to type").toHaveCount(0);
});

test("code-per-shot: minted at the booth, opened by the guest, downloadable", async ({ page }) => {
  await setMode("code-b", "code_per_shot");
  await signIn(page, "code-b");

  // A confirmed shot is in the feed (seeded server-side, as if taken earlier).
  await fetch(`${MOCK}/__test/seed?n=1&source=booth`);
  const mint = page.locator('[data-mint="seed-booth-0"]');
  await expect(mint, "a ready shot grows a Code button in this mode").toBeVisible({ timeout: 10_000 });

  // The operator taps it and turns the screen to the guest.
  await mint.click();
  const shown = page.locator("[data-code]");
  await expect(shown).toBeVisible();
  const code = await shown.getAttribute("data-code");
  expect(code, "a real 14-symbol code, no I/L/O/U").toMatch(/^[0-9A-HJKMNP-TV-Z]{14}$/);

  const qr = page.locator(`canvas[data-qr*="${code}"]`);
  await expect(qr, "the QR encodes the gallery link for that code").toBeVisible();

  // Approve the shot so the publish gate lets the guest see it.
  await api("photo.approve", { photoId: "seed-booth-0" });

  // The guest types the code on their own phone.
  await page.goto("/#/guest");
  await page.locator("input").fill(code!);
  await page.getByRole("button", { name: /open|فتح/i }).click();

  await expect(page.locator(".tile img"), "exactly their shot").toHaveCount(1);
  await expect(page.locator(".tile a[download]"), "with a download").toHaveCount(1);

  // And the delivery row is a real sending path.
  await expect(page.locator('[data-share="whatsapp"]')).toHaveAttribute("href", /^https:\/\/wa\.me\/\?text=/);
  await expect(page.locator('[data-share="sms"]')).toHaveAttribute("href", /^sms:/);
  const wa = await page.locator('[data-share="whatsapp"]').getAttribute("href");
  expect(decodeURIComponent(wa!), "the message carries the gallery link").toContain(`#/guest?code=${code}`);
});

test("registration: the kiosk registers, binds at the shutter, and the code delivers", async ({ page }) => {
  await setMode("reg-c", "registration");
  await signIn(page, "reg-c");
  await page.goto("/#/kiosk");

  // The kiosk leads with the form: no registration, no shutter.
  const form = page.locator("[data-kiosk-register]");
  await expect(form).toBeVisible();
  await expect(page.locator("[data-kiosk-shutter]")).toHaveCount(0);

  await form.locator("input").first().fill("Layla");
  await form.locator('input[type="checkbox"]').check();
  await form.getByRole("button").click();

  // Registered: the shutter appears and the shot binds to the guest.
  const shutter = page.locator("[data-kiosk-shutter]");
  await expect(shutter).toBeVisible({ timeout: 10_000 });
  await page.setInputFiles('input[type="file"]', { name: "guest.png", mimeType: "image/png", buffer: PNG });

  await expect
    .poll(async () => (await (await fetch(`${MOCK}/__test/state`)).json()).confirmed, { timeout: 30_000 })
    .toBe(1);
  const st = await (await fetch(`${MOCK}/__test/state`)).json();
  expect(st.photos[0].guest_id, "the shot carries its guest from the shutter").toBeTruthy();
  expect(st.guests.length, "one registered guest").toBe(1);
  expect(st.photos[0].guest_id).toBe(st.guests[0][0]);

  // The farewell screen hands over the code.
  await page.locator("[data-kiosk-finish]").click();
  const code = await page.locator("[data-code]").getAttribute("data-code");
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{14}$/);
  await expect(page.locator(`canvas[data-qr*="${code}"]`)).toBeVisible();

  // Next guest: the kiosk resets to the form, holding nothing of the last guest.
  await page.locator("[data-next-guest]").click();
  await expect(page.locator("[data-kiosk-register]")).toBeVisible();

  // Approve, then open the gallery the way a scanned QR would: the deep link.
  await api("photo.approve", { photoId: st.photos[0].id });
  await page.goto(`/#/guest?code=${code}`);
  await expect(page.locator(".tile img"), "the scanned link opens itself").toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator(".tile a[download]")).toHaveCount(1);
});

test("three modes live side by side without leaking", async ({ page }) => {
  await setMode("wall-a", "wall_only");
  await setMode("code-b", "code_per_shot");
  await setMode("reg-c", "registration");

  // The registration event registers.
  const reg = await api("guest.register", { slug: "reg-c", displayName: "A", consent: true });
  expect(reg.data.outcome).toBe("ok");

  // The wall-only event refuses the same call — and its guest page still offers nothing.
  const refused = await api("guest.register", { slug: "wall-a", displayName: "B", consent: true });
  expect(refused.data.outcome, "wall_only refuses registration").toBe("mode_refused");

  await page.goto("/#/g/wall-a");
  await expect(page.locator('[data-guest-mode="wall_only"]')).toBeVisible();
  await expect(page.locator("input")).toHaveCount(0);

  // The code event still behaves as a code event.
  await page.goto("/#/g/code-b");
  await expect(page.locator('[data-guest-mode="code_per_shot"]')).toBeVisible();
});
