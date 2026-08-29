import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "../api/client";
import { cacheGet, cacheSet } from "../offline/outbox";
import { pick, useI18n } from "../i18n";

// What every wall shares: the narrow public event shape, the poll-with-last-good-state
// pattern, and the two whole-screen states (panic, empty). A wall's job during a failure is
// to keep showing the room what it already had — going blank is worse than going stale.

export interface PublicEvent {
  slug: string; name: string; name_ar?: string | null; name_en?: string | null;
  status: string; locale_default: string; locales: string[];
  brand_primary: string; brand_secondary: string; brand_font_family?: string | null;
  wall_frozen: boolean; panic_brand_only: boolean;
  banner_active: boolean; banner_text_en?: string | null; banner_text_ar?: string | null;
  guest_mode: string; wall_config: Record<string, unknown> | null;
}

/** Polls one wall data source plus the public event shape, holding the last good answer in
 *  memory and on disk. `stale` is true whenever the screen is showing held state. */
export function useWallFeed<T>(slug: string, action: string, cacheKey: string, pollMs: number) {
  const { locale } = useI18n();
  const [data, setData] = useState<T | null>(null);
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [stale, setStale] = useState(false);
  const lastGood = useRef<{ data: T | null; event: PublicEvent | null }>({ data: null, event: null });

  const poll = useCallback(async () => {
    try {
      const [rows, ev] = await Promise.all([
        call<T>(action, { eventSlug: slug }),
        call<PublicEvent | null>("event.get", { slug }),
      ]);
      lastGood.current = { data: rows, event: ev ?? lastGood.current.event };
      setData(rows);
      if (ev) setEvent(ev);
      setStale(false);
      void cacheSet(cacheKey, { data: rows, event: ev });
    } catch {
      setData(lastGood.current.data);
      setEvent(lastGood.current.event);
      setStale(true);
    }
  }, [slug, action, cacheKey]);

  // A wall that was power-cycled during an outage seeds itself from disk, so the reload that a
  // cut power supply forces still comes back showing a wall.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = await cacheGet<{ data: T; event: PublicEvent }>(cacheKey);
      if (!cancelled && cached && lastGood.current.data === null) {
        lastGood.current = cached;
        setData(cached.data);
        setEvent(cached.event);
        setStale(true);
      }
    })();
    return () => { cancelled = true; };
  }, [cacheKey]);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), pollMs);
    const onWake = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
    };
  }, [poll, pollMs]);

  const title = event ? pick(locale, event.name_ar, event.name_en, event.name) : "";
  const banner = event?.banner_active
    ? pick(locale, event.banner_text_ar, event.banner_text_en, "")
    : "";

  return { data, event, stale, title, banner };
}

export function PanicScreen({ event, title }: { event: PublicEvent; title: string }) {
  const { t } = useI18n();
  return (
    <div className="wall-empty" style={{ color: event.brand_primary }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: "3rem", fontWeight: 700 }}>{title || t.appName}</div>
        <div style={{ marginBlockStart: 12, fontSize: "1rem" }}>{t.wallPanicNotice}</div>
      </div>
    </div>
  );
}

export function WallStateBadge({ frozen, stale }: { frozen?: boolean; stale: boolean }) {
  const { t } = useI18n();
  if (!frozen && !stale) return null;
  return <div className="wall-state">{frozen ? t.wallFrozenNotice : t.offline}</div>;
}

export function WallBanner({ text, color }: { text: string; color?: string }) {
  if (!text) return null;
  return <div className="wall-banner" style={color ? { background: color } : undefined}>{text}</div>;
}
