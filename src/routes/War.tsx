import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Shell } from "../components/Shell";
import { useI18n } from "../i18n";
import { ApiError, call, messageFor } from "../api/client";
import { useSession } from "../state/useSession";

// The war room (feature G): what is coming out of the booth, what is coming out of the kiosk,
// and what the room is seeing — with the power to reorder the room's wall by hand. The swap is
// the audited api_lightbox_place from Phase 2; this screen is its UI.

interface FeedRow {
  id: string; kind: string; status: string; approved: boolean; createdAt: string;
  captureSource: string | null; restyleIntent: string | null;
  jobStatus: string | null; thumbUrl: string | null;
}
interface Cell { cellIndex: number; photoId: string; thumbUrl: string | null }

const CELLS = 28;

export default function War() {
  const { t } = useI18n();
  const { session } = useSession();
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [cells, setCells] = useState<Cell[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const slug = session?.eventSlug ?? "";

  const refresh = useCallback(async () => {
    try {
      const [rows, lb] = await Promise.all([
        call<FeedRow[]>("moderation.feed", { limit: 80 }),
        call<Cell[]>("wall.lightbox", { eventSlug: slug }),
      ]);
      setFeed(rows ?? []);
      setCells(lb ?? []);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && !err.isOffline) {
        setError(messageFor(err.code, t as unknown as Record<string, string>));
      }
    }
  }, [slug, t]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function act(action: string, photoId: string) {
    try {
      await call(action, { photoId });
      await refresh();
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : "", t as unknown as Record<string, string>));
    }
  }

  async function place(cellIndex: number) {
    // Two taps: a photo from either column, then the cell it should occupy. Clearing is the
    // same gesture with no photo picked.
    try {
      await call("lightbox.place", { cellIndex, photoId: picked });
      setPicked(null);
      setNotice(t.placed);
      setTimeout(() => setNotice(null), 1500);
      await refresh();
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : "", t as unknown as Record<string, string>));
    }
  }

  if (!session) return <Navigate to="/operator/login" replace />;

  const byIndex = new Map(cells.map((c) => [c.cellIndex, c]));
  const column = (source: string) =>
    feed.filter((r) => (r.captureSource ?? "booth") === source && r.status === "ready");

  const renderColumn = (title: string, source: string) => (
    <div style={{ flex: 1, minWidth: 260 }}>
      <h2>{title} · {column(source).length}</h2>
      <div className="tiles" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}>
        {column(source).map((p) => (
          <div className="tile" key={p.id}
               data-photo={p.id}
               onClick={() => setPicked(picked === p.id ? null : p.id)}
               style={picked === p.id ? { outline: "2px solid var(--brand)" } : undefined}>
            {p.thumbUrl ? <img src={p.thumbUrl} alt="" loading="lazy" /> : null}
            <div className="meta">
              <span className={`pill ${p.approved ? "ok" : "warn"}`}>
                {p.approved ? t.approved : t.pending}
              </span>
            </div>
            {!p.approved ? (
              <div className="actions">
                <button className="primary" onClick={(e) => { e.stopPropagation(); void act("photo.approve", p.id); }}>
                  {t.approve}
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <Shell title={t.warTitle} wide>
      <div style={{ padding: 20, maxWidth: 1600, marginInline: "auto" }}>
        <h1>{t.warTitle}</h1>
        <p className="lede">{slug} — {t.pickPhotoFirst}</p>
        {error ? <div className="notice bad">{error}</div> : null}
        {notice ? <div className="notice ok">{notice}</div> : null}

        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          {renderColumn(t.boothColumn, "booth")}
          {renderColumn(t.kioskColumn, "kiosk")}

          <div style={{ flex: 1.2, minWidth: 320 }}>
            <h2>{t.wallMirror}</h2>
            <div className="wall-lightbox"
                 style={{ minHeight: 320, background: "var(--surface)", borderRadius: 12 }}>
              {Array.from({ length: CELLS }, (_, i) => {
                const cell = byIndex.get(i);
                return (
                  <div key={i} className="lightbox-cell" data-cell={i}
                       onClick={() => void place(i)}
                       style={{ cursor: "pointer", border: "1px solid var(--line)" }}>
                    {cell?.thumbUrl ? <img src={cell.thumbUrl} alt="" /> : null}
                  </div>
                );
              })}
            </div>
            {picked ? (
              <p className="muted" style={{ marginBlockStart: 8 }}>
                <button className="ghost" onClick={() => setPicked(null)}>{t.cancel}</button>
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </Shell>
  );
}
