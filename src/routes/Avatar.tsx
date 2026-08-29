import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { useI18n } from "../i18n";
import { useSession } from "../state/useSession";
import { deviceId } from "../api/photo";
import { enqueue, startSync, subscribe, type OutboxItem } from "../offline/outbox";
import { call } from "../api/client";

// The avatar kiosk (feature I) and its degradation ladder (law 8):
//
//   rung 1 — LIVE: avatar.session answers ok, because the owner has put the Anam key into
//            Supabase secrets. The kiosk shows the live rung is ready and hands the session
//            to the avatar stage.
//   rung 2 — FALLBACK: avatar.session answers not_configured (today's honest state) or
//            unreachable, or cannot be asked at all. The kiosk runs welcome mode: branded
//            bilingual greeting, working camera, same outbox, same approval queue.
//
// The ladder is decided by asking, never by assuming — and re-asked every minute, so keys
// pasted mid-event light the live rung without a deploy. Either way the camera works and a
// shot is an ordinary unapproved photo labelled 'avatar'.

type Rung = "checking" | "live" | "fallback";

export default function Avatar() {
  const { t, toggle } = useI18n();
  const { session } = useSession();
  const [rung, setRung] = useState<Rung>("checking");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [queueDepth, setQueueDepth] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stopSync = startSync();
    const unsub = subscribe((items: OutboxItem[]) =>
      setQueueDepth(items.filter((i) => i.state !== "done").length));
    const beat = () =>
      call("station.heartbeat", {
        deviceId: deviceId(), kind: "avatar", label: "Avatar kiosk",
        queueDepth, appVersion: "phase-6",
      }).catch(() => { /* greeting continues regardless */ });
    beat();
    const timer = setInterval(beat, 3000);
    return () => { stopSync(); unsub(); clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let stopped = false;
    const climb = async () => {
      try {
        const r = await call<{ outcome: string }>("avatar.session", {});
        if (!stopped) setRung(r.outcome === "ok" ? "live" : "fallback");
      } catch {
        if (!stopped) setRung("fallback");
      }
    };
    void climb();
    const timer = setInterval(() => void climb(), 60_000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !session?.eventId) return;
    setState("sending");
    try {
      await enqueue({
        id: crypto.randomUUID(),
        eventId: session.eventId,
        file,
        restyle: false,
        source: "avatar",
        deviceId: deviceId(),
      });
      setState("done");
      setTimeout(() => setState("idle"), 3500);
    } catch {
      setState("idle");
    }
  }

  if (!session) return <Navigate to="/operator/login" replace />;
  if (session.kind !== "operator") return <Navigate to="/" replace />;

  return (
    <div className="wall" style={{ background: "var(--bg)" }} data-avatar-mode={rung}>
      <div style={{ position: "absolute", insetBlockStart: 14, insetInlineEnd: 14, zIndex: 5,
                    display: "flex", gap: 8, alignItems: "center" }}>
        {/* The honest state, staff-corner sized: guests see a greeting, staff see the truth. */}
        <span className={`pill ${rung === "live" ? "ok" : "warn"}`} data-avatar-state>
          {rung === "live" ? t.avatarLiveNote : t.avatarFallbackNote}
        </span>
        <button className="ghost" onClick={toggle}>{t.language}</button>
      </div>

      <div className="wall-empty" style={{ flexDirection: "column", gap: 18, display: "flex",
                                           alignItems: "center", justifyContent: "center" }}>
        <h1 style={{ fontSize: "2.6rem", margin: 0 }}>{t.avatarWelcome}</h1>
        <p className="muted" style={{ margin: 0, fontSize: "1.1rem" }}>{t.avatarSub}</p>

        <button
          onClick={() => state === "idle" && fileRef.current?.click()}
          data-kiosk-shutter
          style={{
            width: "min(58vw, 42vh)", aspectRatio: "1", borderRadius: 24,
            border: "3px dashed var(--brand)", background: "transparent",
            display: "grid", placeItems: "center", fontSize: "1.3rem", color: "var(--brand)",
          }}
        >
          {state === "idle" ? t.kioskShoot : state === "sending" ? t.kioskSending : t.kioskDone}
        </button>

        {queueDepth > 0 ? <span className="pill warn">{t.queued} · {queueDepth}</span> : null}
      </div>

      <input ref={fileRef} type="file" accept="image/*" capture="user"
             onChange={onFile} style={{ display: "none" }} />
    </div>
  );
}
