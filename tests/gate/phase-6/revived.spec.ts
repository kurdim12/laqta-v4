import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// PHASE 6 GATE, the browser half — the revived five, each finished properly.
//
// The database half is in gate_phase_6() and gate_shirt_catalogue(): picker shots are
// ordinary unapproved photos carrying their choice, a replay cannot rewrite that choice,
// cues and tasks are event-scoped rows whose activity flows through the capped telemetry,
// and a catalogue option without an id is refused. What only a browser can prove:
//
//   - the shirt picker's choice reaches the approval queue, on a shot that is unapproved
//     like every other, through the same outbox;
//   - the avatar kiosk runs its ladder honestly: with no key it says so and STILL shoots,
//     and it climbs to the live rung the moment the key exists — no deploy;
//   - cues and tasks are worked from the control room and the moment is recorded;
//   - the vogue editorial flow is a selectable style of the same wall, same feed.
//
// (Guest delivery, the fifth of the five, was finished in Phase 5 and is gated there.)

const MOCK = "http://localhost:8787";
const PNG = readFileSync(new URL("../phase-1/fixture.png", import.meta.url));

async function signIn(page: Page, slug = "revived-test") {
  await page.goto("/#/operator/login");
  await page.getByPlaceholder("lynk-and-co").fill(slug);
  await page.locator('input[autocomplete="username"]').fill("boothop");
  await page.locator('input[autocomplete="current-password"]').fill("4821");
  await page.getByRole("button", { name: /sign in|دخول/i }).click();
  await expect(page).toHaveURL(/#\/booth/, { timeout: 20_000 });
}

test.beforeEach(async () => {
  await fetch(`${MOCK}/__test/reset`);
});

test("the shirt picker's choice rides the shot into the approval queue", async ({ page }) => {
  await fetch(`${MOCK}/__test/shirts?slug=revived-test&ids=white-classic,navy`);
  await signIn(page);
  await page.goto("/#/shirt");

  // The catalogue is the event's, and picking is the first step.
  await expect(page.locator('[data-shirt="white-classic"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-kiosk-shutter]"), "no shirt, no shutter").toHaveCount(0);

  await page.locator('[data-shirt="navy"]').click();
  await page.locator("[data-kiosk-shutter]").waitFor();
  await page.setInputFiles('input[type="file"]', { name: "s.png", mimeType: "image/png", buffer: PNG });

  await expect
    .poll(async () => (await (await fetch(`${MOCK}/__test/state`)).json()).confirmed, { timeout: 30_000 })
    .toBe(1);

  const st = await (await fetch(`${MOCK}/__test/state`)).json();
  expect(st.photos[0].capture_source, "labelled by its surface").toBe("shirt");
  expect(st.photos[0].style_choice, "carrying what the guest picked").toBe("navy");
  expect(st.photos[0].approved ?? false, "unapproved, like everything else").toBe(false);
  expect(st.enqueues, "and queued for the restyle the pick exists for").toContain(st.photos[0].id);

  // The moderator sees the choice on the shot.
  await page.goto("/#/queue");
  await expect(page.locator(".tile .pill", { hasText: "navy" })).toBeVisible({ timeout: 10_000 });
});

test("the avatar kiosk runs its ladder honestly, and climbs when the key appears", async ({ page }) => {
  await signIn(page);
  await page.goto("/#/avatar");

  // Rung 2: no key. It says so — and the camera still works.
  const stage = page.locator("[data-avatar-mode]");
  await expect(stage).toHaveAttribute("data-avatar-mode", "fallback", { timeout: 15_000 });
  await expect(page.locator("[data-avatar-state]")).toBeVisible();

  await page.setInputFiles('input[type="file"]', { name: "a.png", mimeType: "image/png", buffer: PNG });
  await expect
    .poll(async () => (await (await fetch(`${MOCK}/__test/state`)).json()).confirmed, { timeout: 30_000 })
    .toBe(1);
  const st = await (await fetch(`${MOCK}/__test/state`)).json();
  expect(st.photos[0].capture_source, "an ordinary avatar-surface shot").toBe("avatar");
  expect(st.photos[0].approved ?? false, "in the same queue, unapproved").toBe(false);

  // Rung 1: the key lands (as it will when the owner pastes it into Supabase secrets).
  // The kiosk climbs on its own — this is a reload, not a redeploy.
  await fetch(`${MOCK}/__test/anam?on=1`);
  await page.reload();
  await expect(stage, "the live rung lights up with no code change")
    .toHaveAttribute("data-avatar-mode", "live", { timeout: 15_000 });
});

test("cues and tasks are worked from the control room", async ({ page }) => {
  await signIn(page);
  await page.goto("/#/control");

  await page.locator("[data-new-cue-en]").fill("Doors open");
  await page.locator("[data-new-cue-en]").press("Enter");

  const cue = page.locator("[data-cue]").first();
  await expect(cue).toHaveAttribute("data-cue-status", "pending", { timeout: 10_000 });
  await cue.locator("[data-fire-cue]").click();
  await expect(cue, "a fired cue is recorded as fired")
    .toHaveAttribute("data-cue-status", "done", { timeout: 10_000 });

  await page.locator("[data-new-task]").fill("Check LED wall power");
  await page.locator("[data-new-task]").press("Enter");

  const task = page.locator("[data-task]").first();
  await expect(task).toHaveAttribute("data-task-status", "open", { timeout: 10_000 });
  await task.locator("[data-done-task]").click();
  await expect(task, "a closed task is recorded as closed")
    .toHaveAttribute("data-task-status", "done", { timeout: 10_000 });
});

test("vogue is a style of the same wall, not a second wall", async ({ page }) => {
  await fetch(`${MOCK}/__test/wall?photos=6`);

  await page.goto("/#/wall/revived-test");
  await expect(page.locator('[data-wall-style="classic"]')).toBeVisible({ timeout: 15_000 });

  // The admin switches the style; the wall picks it up on its own poll.
  await fetch(`${MOCK}/__test/style?style=vogue`);
  await expect(page.locator('[data-wall-style="vogue"]'), "the same wall, restyled")
    .toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".vogue-hero img"), "the hero frame").toHaveCount(1);
  await expect(page.locator(".vogue-sheet img"), "and the contact sheet").toHaveCount(5);

  // Panic still empties it: a style change cannot cost the wall its safety behaviour.
  await fetch(`${MOCK}/__test/wall?panic=1`);
  await expect(page.locator('[data-wall-style="vogue"]')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(".wall-empty")).toBeVisible();
});
