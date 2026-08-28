import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { dictionaries, type Locale, type Strings } from "./strings";

// True RTL, not a mirrored stylesheet. The document direction and language are set on <html>,
// so the browser's own bidirectional algorithm handles mixed Arabic and Latin text, form
// controls flip natively, and logical CSS properties do the rest without a second stylesheet.

const STORAGE_KEY = "laqta.locale";

interface I18n {
  locale: Locale;
  dir: "rtl" | "ltr";
  t: Strings;
  setLocale: (l: Locale) => void;
  toggle: () => void;
}

const Ctx = createContext<I18n | null>(null);

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "ar" || saved === "en") return saved;
  } catch {
    // A kiosk in private mode has no storage. Arabic is the default either way.
  }
  return navigator.language?.toLowerCase().startsWith("en") ? "en" : "ar";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const dir = locale === "ar" ? "rtl" : "ltr";

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // Not being able to remember the choice is not a reason to fail the render.
    }
  }, [locale, dir]);

  const setLocale = useCallback((l: Locale) => setLocaleState(l), []);
  const toggle = useCallback(
    () => setLocaleState((l) => (l === "ar" ? "en" : "ar")),
    [],
  );

  const value = useMemo<I18n>(
    () => ({ locale, dir, t: dictionaries[locale], setLocale, toggle }),
    [locale, dir, setLocale, toggle],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useI18n outside I18nProvider");
  return ctx;
}

/** Picks the right side of a bilingual pair coming from the database, falling back rather
 *  than rendering an empty heading on a wall. */
export function pick(locale: Locale, ar?: string | null, en?: string | null, fallback = ""): string {
  const first = locale === "ar" ? ar : en;
  const second = locale === "ar" ? en : ar;
  return (first || second || fallback).trim();
}
