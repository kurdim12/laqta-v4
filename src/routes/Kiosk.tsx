import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { useI18n } from "../i18n";
import { useSession } from "../state/useSession";
import { deviceId } from "../api/photo";
import { enqueue, startSync, subscribe, type OutboxItem } from "../offline/outbox";
import { warmCutout } from "../api/cutout";
import { call } from "../api/client";

// The iPad self-serve kiosk (feature C): a staff member signs the device in once; from then on
// it is a guest-facing full-screen camera with a square framing guide. Shots are auto-cropped
// square and land UNAPPROVED in the moderation queue — the kiosk trusts nobody, including
// itself. Same outbox as the booth, so the offline law covers this surface identically.

/** Center-crops a capture to a square before it enters the pipeline, so the framing guide the
 *  guest saw is the truth of what was kept. */
async function autoCropSquare(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  const canvas = document.createElement("canvas");
  const edge = Math.min(side, 2048);
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext("2d");
  if (!ctx) { bitmap.close?.(); return file; }
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, edge, edge);
  bitmap.close?.();
  const out: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
  return out ?? file;
}

export default function Kiosk() {
  const { t, toggle } = useI18n();
  const { session } = useSession();
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [queueDepth, setQueueDepth] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void warmCutout();
    const stopSync = startSync();
    const unsub = subscribe((items: OutboxItem[]) =>
      setQueueDepth(items.filter((i) => i.state !== "done").length));

    const beat = () =>
      call("station.heartbeat", {
        deviceId: deviceId(), kind: "kiosk", label: "Kiosk",
        queueDepth, appVersion: "phase-4",
      }).catch(() => { /* the kiosk keeps shooting regardless */ });
    beat();
    const timer = setInterval(beat, 3000);
    return () => { stopSync(); unsub(); clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !session?.eventId) return;
    setState("sending");
    try {
      const squared = await autoCropSquare(file);
      await enqueue({
        id: crypto.randomUUID(),
        eventId: session.eventId,
        file: squared,
        restyle: false,
        source: "kiosk",
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
    <div className="wall" style={{ background: "var(--bg)" }}>
      <div style={{ position: "absolute", insetBlockStart: 14, insetInlineEnd: 14, zIndex: 5 }}>
        <button className="ghost" onClick={toggle}>{t.language}</button>
      </div>

      <div className="wall-empty" style={{ flexDirection: "column", gap: 24, display: "flex",
                                           alignItems: "center", justifyContent: "center" }}>
        <h1 style={{ fontSize: "2.2rem", margin: 0 }}>{t.kioskTitle}</h1>

        {/* The square framing guide: what the guest sees inside the frame is what is kept. */}
        <button
          onClick={() => state === "idle" && fileRef.current?.click()}
          data-kiosk-shutter
          style={{
            width: "min(64vw, 46vh)", aspectRatio: "1", borderRadius: 24,
            border: "3px dashed var(--brand)", background: "transparent",
            display: "grid", placeItems: "center", fontSize: "1.3rem", color: "var(--brand)",
          }}
        >
          {state === "idle" ? t.kioskShoot : state === "sending" ? t.kioskSending : t.kioskDone}
        </button>

        {queueDepth > 0 ? (
          <span className="pill warn">{t.queued} · {queueDepth}</span>
        ) : null}
      </div>

      <input ref={fileRef} type="file" accept="image/*" capture="user"
             onChange={onFile} style={{ display: "none" }} />
    </div>
  );
}
