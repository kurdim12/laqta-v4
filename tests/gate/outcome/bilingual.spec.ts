// DRIVES: tests/gate/phase-1/mock-api.mjs (an in-memory stand-in), NOT the deployed
// backend - this container's network policy refuses CONNECT to the project domain.
// The static half of this file reads the repository directly and drives nothing.
// See tests/gate/README.md.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// SHOULD-FIX — THE BILINGUAL PASS.
//
// The contract calls bilingual AR/EN with true RTL "a first-class requirement across every
// surface — no hardcoded strings", and the audit recorded a bilingual pass as outstanding.
// Inspecting it, the substance was already there: 236 keys, both languages, complete; logical
// CSS properties throughout; dir and lang set on <html>. What was missing was any check that
// keeps it that way. A first-class requirement that nothing asserts is a requirement that
// decays on the next busy afternoon — one English string added to a kiosk, one margin-left in
// a hurry, and nothing anywhere says a word.
//
// So this gate does not re-do the translation. It makes the translation ENFORCED:
//
//   statically — the two dictionaries stay in step, no Arabic value is secretly the English
//   one, and no physical direction property enters the stylesheet or a style prop;
//
//   in the browser — every surface, in Arabic, actually flips, actually fits, and does not
//   leak an English UI string from the dictionary it was supposed to translate.

const MOCK = "http://localhost:8787";
const ROOT = new URL("../../../", import.meta.url).pathname;

/* ------------------------------------------------------------------- the static half */

function readDict(): { en: Record<string, string>; ar: Record<string, string> } {
  const src = readFileSync(join(ROOT, "src/i18n/strings.ts"), "utf8");
  // Each dictionary is an object literal of `key: "value",` lines. Parsing them positionally
  // is enough and avoids importing TypeScript into a Playwright process.
  const dicts: Record<string, string>[] = [];
  for (const block of src.split(/const\s+\w+\s*:\s*Strings\s*=\s*\{|export const dictionaries/)) {
    const entries: Record<string, string> = {};
    for (const m of block.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*)\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*$/gm)) {
      entries[m[1]] = m[2];
    }
    if (Object.keys(entries).length > 20) dicts.push(entries);
  }
  expect(dicts.length, "two dictionaries were found in strings.ts").toBe(2);
  return { en: dicts[0], ar: dicts[1] };
}

/** Values that are legitimately identical in both languages: acronyms, brand words, and
 *  symbols. Anything NOT on this list that matches its English twin is an untranslated
 *  string wearing a translation's clothes. */
const SAME_IN_BOTH = new Set(["qr", "pin", "ai", "sms", "whatsapp", "laqta", "led", "ok"]);

test("the two dictionaries stay in step, and nothing is quietly untranslated", () => {
  const { en, ar } = readDict();

  const missingAr = Object.keys(en).filter((k) => !(k in ar));
  const missingEn = Object.keys(ar).filter((k) => !(k in en));
  expect(missingAr, "every English key has an Arabic one").toEqual([]);
  expect(missingEn, "and every Arabic key has an English one").toEqual([]);
  expect(Object.keys(en).length, "the dictionary is not empty").toBeGreaterThan(200);

  // An Arabic value byte-identical to the English one is the shape a hurried addition takes:
  // the key exists in both files, the parity check above is happy, and the guest reads English.
  const copied = Object.keys(en).filter((k) =>
    en[k] === ar[k] && !SAME_IN_BOTH.has(en[k].trim().toLowerCase()) && /[A-Za-z]{3}/.test(en[k]));
  expect(copied, "no Arabic value is just the English one pasted across").toEqual([]);

  // And nothing empty: a blank translation renders a blank button.
  const blank = Object.keys(ar).filter((k) => ar[k].trim() === "");
  expect(blank, "no translation is blank").toEqual([]);
});

test("no physical direction property can enter the styles", () => {
  // True RTL means the layout flips because the properties are logical, not because a second
  // mirrored stylesheet exists. One `margin-left` is all it takes for a panel to sit on the
  // wrong side in Arabic while looking perfect in English — the bug nobody sees in review.
  const offenders: string[] = [];
  const PHYSICAL = [
    /\bmargin-(left|right)\s*:/, /\bpadding-(left|right)\s*:/,
    /\bborder-(left|right)(-\w+)?\s*:/, /\btext-align\s*:\s*(left|right)\b/,
    /\bmarginLeft\b/, /\bmarginRight\b/, /\bpaddingLeft\b/, /\bpaddingRight\b/,
    /\bborderLeft\b/, /\bborderRight\b/,
    /\btextAlign\s*:\s*["'](left|right)["']/,
  ];

  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(tsx?|css)$/.test(name)) continue;
      const text = readFileSync(full, "utf8");
      text.split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
        for (const re of PHYSICAL) {
          if (re.test(line)) offenders.push(`${full.slice(ROOT.length)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
  };
  walk(join(ROOT, "src"));

  expect(offenders,
    "use logical properties (margin-inline-start, padding-inline-end, text-align: start)")
    .toEqual([]);
});

/* ------------------------------------------------------------------ the browser half */

async function signIn(page: Page) {
  await page.goto("/#/operator/login");
  await page.getByPlaceholder("lynk-and-co").fill("bilingual");
  await page.locator('input[autocomplete="username"]').fill("booth1");
  // Any PIN: the mock's operator.login accepts anything, and a real one here would publish a
  // live credential in a public repository while proving nothing.
  await page.locator('input[autocomplete="current-password"]').fill("000000");
  await page.getByRole("button", { name: /sign in|دخول/i }).click();
  await expect(page).toHaveURL(/#\/booth/, { timeout: 20_000 });
}

/** Arabic before the first render, the way a phone in Amman arrives. */
async function arabic(page: Page) {
  await page.addInitScript(() => localStorage.setItem("laqta.locale", "ar"));
}

const SIGNED_IN_ROUTES = ["/#/booth", "/#/kiosk", "/#/control", "/#/war", "/#/queue", "/#/shirt"];
const OPEN_ROUTES = ["/#/guest", "/#/operator/login", "/#/admin/login", "/#/wall/bilingual"];

async function api(action: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${MOCK}/api`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
  return res.json();
}

/** An OPEN gallery holding a real photo, not the empty code prompt.
 *
 *  This exists because the first version of this gate walked `/#/guest` and called the guest
 *  side covered. `/#/guest` with no code is a single input — the tiles, the download control
 *  and the share row are all behind a lookup, so a hardcoded English label on any of them was
 *  invisible to the check. Injecting one proved it: the gate stayed green. A surface is not
 *  covered until the gate reaches the state where its strings actually render. */
async function routesWithContent(): Promise<string[]> {
  await fetch(`${MOCK}/__test/mode?slug=bilingual&mode=code_per_shot`);
  await fetch(`${MOCK}/__test/seed?n=1&source=booth`);
  const mint = await api("photo.mintCode", { photoId: "seed-booth-0" });
  await api("photo.approve", { photoId: "seed-booth-0" });
  const code = mint?.data?.code;
  expect(code, "the gallery fixture has a code").toBeTruthy();
  return [...OPEN_ROUTES, ...SIGNED_IN_ROUTES, `/#/guest?code=${code}`];
}

test("every surface, in Arabic, flips and fits", async ({ page }) => {
  await arabic(page);
  await fetch(`${MOCK}/__test/reset`);
  await signIn(page);
  const routes = await routesWithContent();

  for (const route of routes) {
    await page.goto(route);
    await page.waitForTimeout(600);

    const state = await page.evaluate(() => ({
      dir: document.documentElement.dir,
      lang: document.documentElement.lang,
      // A horizontal scrollbar on a phone is the classic RTL breakage: something is pinned to
      // a physical side and pushes the page off its own edge.
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));

    expect(state.dir, `${route} flips to RTL`).toBe("rtl");
    expect(state.lang, `${route} declares Arabic`).toBe("ar");
    expect(state.overflow, `${route} does not scroll sideways in Arabic`).toBeLessThanOrEqual(1);
  }
});

test("no English UI string leaks onto an Arabic surface", async ({ page }) => {
  const { en, ar } = readDict();
  // Only strings long enough to be unambiguous, and only where the Arabic genuinely differs —
  // so an acronym or a shared word cannot produce a false accusation.
  const englishOnly = Object.keys(en)
    .filter((k) => en[k].length >= 6 && en[k] !== ar[k] && /^[\x20-\x7E]+$/.test(en[k]))
    .map((k) => en[k]);
  expect(englishOnly.length, "there is something to look for").toBeGreaterThan(50);

  await arabic(page);
  await fetch(`${MOCK}/__test/reset`);
  await signIn(page);
  const routes = await routesWithContent();

  for (const route of routes) {
    await page.goto(route);
    await page.waitForTimeout(600);

    // Leaf text, not innerText. A leaked LABEL renders as an element whose whole text is the
    // dictionary string; DATA that happens to contain an English word ("Test Operator", an
    // event called "Lynk & Co") renders as something longer and different. Scanning the whole
    // page body cannot tell those apart and accuses the fixture's own operator name — which is
    // how a check like this earns a reputation for crying wolf and gets deleted.
    //
    // What this catches: a control, heading or message rendered from a literal instead of
    // through `t`. What it does not: an English word buried mid-sentence in a composite. The
    // dictionary checks above cover the other direction, and a scope stated is worth more than
    // a scope implied.
    const leaves = await page.evaluate(() =>
      Array.from(document.body.querySelectorAll("*"))
        .filter((el) => el.children.length === 0 && (el as HTMLElement).innerText?.trim())
        .map((el) => (el as HTMLElement).innerText.trim()));

    const leaked = englishOnly.filter((v) =>
      leaves.some((leaf) => leaf === v || leaf.startsWith(`${v} `)));
    expect(leaked, `${route} shows no untranslated dictionary string`).toEqual([]);
  }
});
