import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { Shell } from "../components/Shell";
import { useI18n } from "../i18n";
import { ApiError, call, messageFor } from "../api/client";
import { useSession } from "../state/useSession";
import { deviceId, sendCapture } from "../api/photo";

interface FeedRow {
  id: string;
  status: string;
  approved: boolean;
  created_at: string;
  job_status?: string | null;
}

type ShotState = "sending" | "sent" | "failed";
interface Shot { id: string; state: ShotState; error?: string }

export default function Booth() {
  const { t } = useI18n();
  const { session } = useSession();
  const [shots, setShots] = useState<Shot[]>([]);
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [restyle, setRestyle] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setFeed(await call<FeedRow[]>("booth.feed", { limit: 24 }));
      setError(null);
    } catch (err) {
      // A feed that cannot refresh is a display problem, never a capture problem. The booth
      // stays usable so the queue on this device keeps draining.
      if (err instanceof ApiError && !err.isOffline) {
        setError(messageFor(err.code, t as unknown as Record<string, string>));
      }
    }
  }, [t]);

  useEffect(() => {
    if (!session) return;
    void refresh();
    const feedTimer = setInterval(() => void refresh(), 5000);

    // The heartbeat is what lets ops see this booth as online, with the depth of whatever it
    // is still holding locally.
    const beat = () =>
      call("station.heartbeat", {
        deviceId: deviceId(), kind: "booth", label: session.booth ?? "",
        queueDepth: shotsInFlight(), appVersion: "phase-0",
      }).catch(() => { /* a missed heartbeat is not worth interrupting a shoot for */ });
    beat();
    const beatTimer = setInterval(beat, 10000);

    return () => {
      clearInterval(feedTimer);
      clearInterval(beatTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, refresh]);

  const shotsRef = useRef<Shot[]>([]);
  shotsRef.current = shots;
  function shotsInFlight(): number {
    return shotsRef.current.filter((s) => s.state === "sending" || s.state === "failed").length;
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    // The id is minted here, on the device, before anything is sent. Every later step keys on
    // it, so a retry after an outage converges on one photo instead of two.
    const photoId = crypto.randomUUID();
    const pending: Shot = { id: photoId, state: "sending" };
    setShots((s) => [pending, ...s].slice(0, 12));

    try {
      await sendCapture({
        photoId, file, restyle, deviceId: deviceId(),
        capturedAt: Date.now(), source: "booth",
      });
      setShots((s) => s.map((x) => (x.id === photoId ? { ...x, state: "sent" } : x)));
      void refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "somethingWentWrong";
      setShots((s) => s.map((x) => (x.id === photoId ? { ...x, state: "failed", error: code } : x)));
      setError(messageFor(code, t as unknown as Record<string, string>));
    }
  }

  if (!session) return <Navigate to="/operator/login" replace />;
  if (session.kind !== "operator") return <Navigate to="/" replace />;

  return (
    <Shell title={t.boothTitle}>
      <h1>{t.boothTitle}</h1>
      <p className="lede">
        {session.displayName} · {t.booth} {session.booth} · {session.eventSlug}
      </p>

      {error ? <div className="notice bad">{error}</div> : null}

      <div className="row">
        <button className="primary" onClick={() => fileRef.current?.click()}>{t.takePhoto}</button>
        <label style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={restyle}
                 onChange={(e) => setRestyle(e.target.checked)} />
          <span style={{ margin: 0 }}>{restyle ? t.restyle : t.straightThrough}</span>
        </label>
      </div>
      <input ref={fileRef} type="file" accept="image/*" capture="environment"
             onChange={onFile} style={{ display: "none" }} />

      {shots.length ? (
        <>
          <h2>{t.sending}</h2>
          <div className="row">
            {shots.map((s) => (
              <span key={s.id}
                    className={`pill ${s.state === "sent" ? "ok" : s.state === "failed" ? "bad" : "warn"}`}>
                {s.state === "sent" ? t.sent : s.state === "failed" ? t.failed : t.sending}
              </span>
            ))}
          </div>
        </>
      ) : null}

      <h2>{t.liveFeed}</h2>
      {feed.length === 0 ? (
        <p className="muted">{t.nothingYet}</p>
      ) : (
        <div className="tiles">
          {feed.map((p) => (
            <div className="tile" key={p.id}>
              <div className="meta">
                <span className={`pill ${p.approved ? "ok" : "warn"}`}>
                  {p.approved ? t.onTheWall : t.pending}
                </span>
                <span className="muted" style={{ fontSize: ".78rem" }}>
                  {new Date(p.created_at).toLocaleTimeString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}
