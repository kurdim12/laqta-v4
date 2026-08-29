import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Shell } from "../components/Shell";
import { useI18n } from "../i18n";
import { ApiError, call, messageFor } from "../api/client";
import { useSession } from "../state/useSession";

interface FeedRow {
  id: string;
  status: string;
  approved: boolean;
  createdAt: string;
  captureSource?: string | null;
  styleChoice?: string | null;
  sourcePhotoId?: string | null;
  jobStatus?: string | null;
  thumbUrl?: string | null;
}

export default function Queue() {
  const { t } = useI18n();
  const { session } = useSession();
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows(await call<FeedRow[]>("moderation.feed", { limit: 60 }));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && !err.isOffline) {
        setError(messageFor(err.code, t as unknown as Record<string, string>));
      }
    }
  }, [t]);

  useEffect(() => {
    if (!session) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [session, refresh]);

  async function act(action: string, photoId: string, extra: Record<string, unknown> = {}) {
    setBusy(photoId);
    setError(null);
    try {
      await call(action, { photoId, ...extra });
      await refresh();
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : "", t as unknown as Record<string, string>));
    } finally {
      setBusy(null);
    }
  }

  if (!session) return <Navigate to="/operator/login" replace />;
  if (session.kind !== "operator") return <Navigate to="/" replace />;

  const waiting = rows.filter((r) => !r.approved && r.status === "ready");
  const live = rows.filter((r) => r.approved);

  return (
    <Shell title={t.queueTitle}>
      <h1>{t.queueTitle}</h1>
      <p className="lede">{session.eventSlug}</p>
      {error ? <div className="notice bad">{error}</div> : null}

      <h2>{t.pending} · {waiting.length}</h2>
      {waiting.length === 0 ? (
        <p className="muted">{t.nothingToReview}</p>
      ) : (
        <div className="tiles">
          {waiting.map((p) => (
            <div className="tile" key={p.id}>
              {p.thumbUrl ? <img src={p.thumbUrl} alt="" loading="lazy" /> : null}
              <div className="meta">
                <span className="pill warn">{t.pending}</span>
                {p.captureSource ? <span className="pill">{p.captureSource}</span> : null}
                {/* What the guest picked at a picker surface: the moderator should be able to
                    see whether the shot got the thing it was taken for. */}
                {p.styleChoice ? <span className="pill">{p.styleChoice}</span> : null}
                <span className="muted" style={{ fontSize: ".78rem" }}>
                  {new Date(p.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="actions">
                <button className="primary" disabled={busy === p.id}
                        onClick={() => act("photo.approve", p.id)}>{t.approve}</button>
                {p.sourcePhotoId ? (
                  <button disabled={busy === p.id}
                          onClick={() => act("photo.useOriginal", p.id)}>{t.useOriginal}</button>
                ) : null}
                <button disabled={busy === p.id}
                        onClick={() => act("photo.reject", p.id, { reason: "queue" })}>{t.reject}</button>
                <button className="danger" disabled={busy === p.id}
                        onClick={() => act("photo.delete", p.id, { reason: "queue" })}>{t.deletePhoto}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2>{t.onTheWall} · {live.length}</h2>
      {live.length === 0 ? (
        <p className="muted">{t.nothingYet}</p>
      ) : (
        <div className="tiles">
          {live.map((p) => (
            <div className="tile" key={p.id}>
              {p.thumbUrl ? <img src={p.thumbUrl} alt="" loading="lazy" /> : null}
              <div className="meta"><span className="pill ok">{t.approved}</span></div>
              <div className="actions">
                <button disabled={busy === p.id}
                        onClick={() => act("photo.unapprove", p.id)}>{t.unapprove}</button>
                <button disabled={busy === p.id}
                        onClick={() => act("photo.hide", p.id)}>{t.hide}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}
