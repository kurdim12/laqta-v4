import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useI18n, pick } from "../i18n";
import { ApiError, call } from "../api/client";

interface WallPhoto { id: string; kind: string; createdAt: string; thumbUrl: string | null }
interface EventRow {
  slug: string; name: string; name_ar?: string | null; name_en?: string | null;
  brand_primary: string; brand_secondary: string;
  wall_frozen: boolean; panic_brand_only: boolean;
  banner_active: boolean; banner_text_en?: string | null; banner_text_ar?: string | null;
}

const POLL_MS = 5000;

/** The screen the room sees.
 *
 *  It holds the last good set of photos in memory and keeps rendering it when a poll fails, so
 *  a network blip is invisible to five hundred people. It never asks for an original: the API
 *  action it calls returns thumbnails only, and the database function behind that has no
 *  column in which an original could be named. */
export default function Wall() {
  const { slug = "" } = useParams();
  const { locale, t } = useI18n();
  const [photos, setPhotos] = useState<WallPhoto[]>([]);
  const [event, setEvent] = useState<EventRow | null>(null);
  const [stale, setStale] = useState(false);
  const lastGood = useRef<WallPhoto[]>([]);

  const poll = useCallback(async () => {
    try {
      const [rows, ev] = await Promise.all([
        call<WallPhoto[]>("wall.photos", { eventSlug: slug, limit: 40 }),
        call<EventRow | null>("event.get", { slug }),
      ]);
      lastGood.current = rows ?? [];
      setPhotos(lastGood.current);
      if (ev) setEvent(ev);
      setStale(false);
    } catch (err) {
      // Keep showing the last good wall. Going blank is worse than going stale.
      if (err instanceof ApiError) setStale(true);
      setPhotos(lastGood.current);
    }
  }, [slug]);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    // A wall that has been asleep or was refreshed reconciles the moment it is visible again,
    // rather than waiting out the poll interval.
    const onVisible = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [poll]);

  const title = event ? pick(locale, event.name_ar, event.name_en, event.name) : "";
  const banner = event?.banner_active
    ? pick(locale, event.banner_text_ar, event.banner_text_en, "")
    : "";

  return (
    <div className="wall" style={event ? { background: "#000" } : undefined}>
      {banner ? (
        <div className="wall-banner" style={{ background: event?.brand_primary ?? undefined }}>
          {banner}
        </div>
      ) : null}

      {event?.panic_brand_only ? (
        <div className="wall-empty" style={{ color: event.brand_primary }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "3rem", fontWeight: 700 }}>{title || t.appName}</div>
            <div style={{ marginBlockStart: 12, fontSize: "1rem" }}>{t.wallPanicNotice}</div>
          </div>
        </div>
      ) : photos.length === 0 ? (
        <div className="wall-empty">{t.wallEmpty}</div>
      ) : (
        <div className="wall-grid">
          {photos.map((p) =>
            p.thumbUrl ? <img key={p.id} src={p.thumbUrl} alt="" loading="lazy" /> : null,
          )}
        </div>
      )}

      {(stale || event?.wall_frozen) ? (
        <div className="wall-state">
          {event?.wall_frozen ? t.wallFrozenNotice : t.offline}
        </div>
      ) : null}
    </div>
  );
}
