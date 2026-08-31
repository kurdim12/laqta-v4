import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Shell } from "../components/Shell";
import { useI18n } from "../i18n";
import { ApiError, call, messageFor } from "../api/client";
import { useSession } from "../state/useSession";
import { deviceId } from "../api/photo";
import { enqueue, kick, list, needsAttention, needsSignIn, startSync, subscribe, type OutboxItem } from "../offline/outbox";
import { warmCutout } from "../api/cutout";
import { Qr, galleryLink } from "../components/Qr";

interface FeedRow {
  id: string;
  status: string;
  approved: boolean;
  created_at: string;
  job_status?: string | null;
}

export default function Booth() {
  const { t } = useI18n();
  const { session } = useSession();
  const navigate = useNavigate();
  const [queue, setQueue] = useState<OutboxItem[]>([]);
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [restyle, setRestyle] = useState(false);
  const [guestMode, setGuestMode] = useState<string>("wall_only");
  const [shownCode, setShownCode] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<OutboxItem[]>([]);
  queueRef.current = queue;

  // The sync loop runs for the life of this page, and the queue view is driven by the outbox
  // itself rather than by component state — so a reload shows exactly what is still on disk.
  useEffect(() => {
    // Warm the background-removal model while the operator is still settling in, so the
    // first real shot does not pay the model-load cost. Failure marks cutouts unavailable
    // for the session — the honest degrade, decided once, not 25 seconds per shot.
    void warmCutout();
    const stopSync = startSync();
    const unsubscribe = subscribe(setQueue);
    void list().then(setQueue);
    return () => { stopSync(); unsubscribe(); };
  }, []);

  // The guest mode decides whether this booth hands out codes. It is read once per session;
  // the database re-checks it on every mint, so a stale read can only hide the button, never
  // mint a code the mode forbids.
  useEffect(() => {
    if (!session?.eventSlug) return;
    call<{ guest_mode?: string } | null>("event.get", { slug: session.eventSlug })
      .then((e) => setGuestMode(e?.guest_mode ?? "wall_only"))
      .catch(() => { /* stays wall_only: no button, nothing lost */ });
  }, [session?.eventSlug]);

  async function mintCode(photoId: string) {
    try {
      const row = await call<{ code: string } | null>("photo.mintCode", { photoId });
      if (row?.code) setShownCode(row.code);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(code === "MODE_REFUSES_PHOTO_CODE"
        ? t.modeNoCodes
        : (err instanceof ApiError && err.isOffline ? t.needConnection
           : messageFor(code, t as unknown as Record<string, string>)));
    }
  }

  const refresh = useCallback(async () => {
    try {
      setFeed(await call<FeedRow[]>("booth.feed", { limit: 24 }));
      setError(null);
    } catch (err) {
      // A feed that cannot refresh is a display problem, never a capture problem. The booth
      // stays fully usable so the queue on this device keeps draining.
      if (err instanceof ApiError && !err.isOffline) {
        setError(messageFor(err.code, t as unknown as Record<string, string>));
      }
    }
  }, [t]);

  useEffect(() => {
    if (!session) return;
    void refresh();
    const feedTimer = setInterval(() => void refresh(), 5000);

    const beat = () => {
      const depth = queueRef.current.filter((i) => i.state !== "done").length;
      call("station.heartbeat", {
        deviceId: deviceId(), kind: "booth", label: session.booth ?? "",
        queueDepth: depth, appVersion: "phase-1",
      }).catch(() => { /* a missed heartbeat is not worth interrupting a shoot for */ });
    };
    beat();
    const beatTimer = setInterval(beat, 10000);

    return () => { clearInterval(feedTimer); clearInterval(beatTimer); };
  }, [session, refresh]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !session?.eventId) return;

    // The id is minted here, at the shutter, before anything is attempted. The photo is on
    // disk before the first request is ever tried, so an outage cannot cost us this shot.
    try {
      await enqueue({
        id: crypto.randomUUID(),
        eventId: session.eventId,
        file,
        restyle,
        source: "booth",
        deviceId: deviceId(),
      });
      setError(null);
    } catch {
      setError(t.somethingWentWrong);
    }
  }

  if (!session) return <Navigate to="/operator/login" replace />;
  if (session.kind !== "operator") return <Navigate to="/" replace />;

  const waiting = queue.filter((i) => i.state !== "done");
  const stuck = needsAttention(queue);

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
        {waiting.length > 0 ? (
          <button className="ghost" onClick={() => void kick()}>
            {t.retry} ({waiting.length})
          </button>
        ) : null}
      </div>
      <input ref={fileRef} type="file" accept="image/*" capture="environment"
             onChange={onFile} style={{ display: "none" }} />

      {/* An expired session is not a broken photo. It is the one failure a person can fix in
          ten seconds, so it gets its own message and its own button rather than being buried
          in a count of things that went wrong. */}
      {needsSignIn(queue) ? (
        <div className="notice warn" data-needs-signin>
          {t.signInAgain}{" "}
          <button className="ghost" onClick={() => navigate("/operator/login")}>{t.signIn}</button>
        </div>
      ) : stuck.length > 0 ? (
        <div className="notice warn">
          {t.failed} · {stuck.length} — {messageFor(stuck[0].lastError ?? "", t as unknown as Record<string, string>)}
        </div>
      ) : null}

      {waiting.length > 0 ? (
        <>
          <h2>{t.queued} · {waiting.length}</h2>
          <p className="muted" style={{ fontSize: ".85rem", marginBlockStart: -6 }}>
            {t.connectionLost}
          </p>
          <div className="row">
            {waiting.map((i) => (
              <span key={i.id}
                    className={`pill ${(i.hardFailures ?? 0) >= 3 ? "bad" : i.state === "sending" ? "warn" : ""}`}>
                {(i.hardFailures ?? 0) >= 3 ? t.failed : i.state === "sending" ? t.sending : t.queued}
                {i.attempts > 0 ? ` · ${i.attempts}` : ""}
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
                {guestMode === "code_per_shot" && p.status === "ready" ? (
                  <button className="ghost" data-mint={p.id}
                          onClick={() => void mintCode(p.id)}>
                    {t.showCode}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {shownCode ? (
        // The hand-over screen: the operator turns the tablet, the guest scans or reads the
        // code. Rendered locally, so it works while the venue's internet is down.
        <div
          style={{ position: "fixed", inset: 0, zIndex: 40, background: "var(--bg)",
                   display: "flex", flexDirection: "column", alignItems: "center",
                   justifyContent: "center", gap: 16, padding: 24 }}
        >
          <h2 style={{ margin: 0 }}>{t.yourCode}</h2>
          <p className="muted" style={{ margin: 0 }}>{t.codeReady}</p>
          <p data-code={shownCode}
             style={{ fontFamily: "ui-monospace, monospace", fontSize: "1.8rem",
                      letterSpacing: ".16em", margin: 0, overflowWrap: "anywhere",
                      textAlign: "center" }}>
            {shownCode}
          </p>
          <Qr value={galleryLink(shownCode)} size={260} />
          <button className="primary" onClick={() => setShownCode(null)}>{t.close}</button>
        </div>
      ) : null}
    </Shell>
  );
}
