import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { useI18n } from "../i18n";
import { useSession } from "../state/useSession";
import { deviceId } from "../api/photo";
import { enqueue, startSync, subscribe, type OutboxItem } from "../offline/outbox";
import { call } from "../api/client";

// The shirt-picker kiosk (feature I), revived properly: the guest picks a shirt, takes the
// shot, and the choice rides the photo row as capture provenance. The shot is an ORDINARY
// photo — same outbox (law 1), same approval queue (feature E), same restyle pipeline: the
// AI runner reads the recorded choice and styles what was actually asked for, and when AI is
// unconfigured or capped the branded original stands, exactly like every other restyle.

interface ShirtOption { id: string; en?: string; ar?: string }

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

export default function Shirt() {
  const { t, toggle, locale } = useI18n();
  const { session } = useSession();
  const [options, setOptions] = useState<ShirtOption[]>([]);
  const [picked, setPicked] = useState<ShirtOption | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [queueDepth, setQueueDepth] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stopSync = startSync();
    const unsub = subscribe((items: OutboxItem[]) =>
      setQueueDepth(items.filter((i) => i.state !== "done").length));
    const beat = () =>
      call("station.heartbeat", {
        deviceId: deviceId(), kind: "shirt", label: "Shirt kiosk",
        queueDepth, appVersion: "phase-6",
      }).catch(() => { /* the picker keeps working regardless */ });
    beat();
    const timer = setInterval(beat, 3000);
    return () => { stopSync(); unsub(); clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!session?.eventSlug) return;
    call<{ shirt_options?: ShirtOption[] } | null>("event.get", { slug: session.eventSlug })
      .then((e) => setOptions(Array.isArray(e?.shirt_options) ? e!.shirt_options! : []))
      .catch(() => { /* an unreadable catalogue is an empty one, honestly shown */ });
  }, [session?.eventSlug]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !session?.eventId || !picked) return;
    setState("sending");
    try {
      const squared = await autoCropSquare(file);
      // restyle: the whole point of picking a shirt is having it applied; if AI is paused or
      // unconfigured the enqueue is refused server-side and the branded original stands.
      await enqueue({
        id: crypto.randomUUID(),
        eventId: session.eventId,
        file: squared,
        restyle: true,
        source: "shirt",
        deviceId: deviceId(),
        styleChoice: picked.id,
      });
      setState("done");
      setTimeout(() => { setState("idle"); setPicked(null); }, 3500);
    } catch {
      setState("idle");
    }
  }

  if (!session) return <Navigate to="/operator/login" replace />;
  if (session.kind !== "operator") return <Navigate to="/" replace />;

  const label = (o: ShirtOption) => (locale === "ar" ? o.ar : o.en) || o.en || o.id;

  return (
    <div className="wall" style={{ background: "var(--bg)" }}>
      <div style={{ position: "absolute", insetBlockStart: 14, insetInlineEnd: 14, zIndex: 5 }}>
        <button className="ghost" onClick={toggle}>{t.language}</button>
      </div>

      {!picked ? (
        <div className="wall-empty" style={{ flexDirection: "column", gap: 20, display: "flex",
                                             alignItems: "center", justifyContent: "center", padding: 24 }}>
          <h1 style={{ fontSize: "2rem", margin: 0 }}>{t.shirtTitle}</h1>
          {options.length === 0 ? (
            <p className="muted">{t.shirtNone}</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                          gap: 14, width: "min(680px, 92vw)" }}>
              {options.map((o) => (
                <button key={o.id} data-shirt={o.id} onClick={() => setPicked(o)}
                        style={{ padding: "26px 12px", fontSize: "1.1rem", borderRadius: 16,
                                 border: "2px solid var(--brand)", background: "transparent",
                                 color: "var(--brand)" }}>
                  {label(o)}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="wall-empty" style={{ flexDirection: "column", gap: 20, display: "flex",
                                             alignItems: "center", justifyContent: "center" }}>
          <h1 style={{ fontSize: "1.6rem", margin: 0 }}>{label(picked)}</h1>
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
          <button className="ghost" onClick={() => setPicked(null)}>{t.shirtChangePick}</button>
          {queueDepth > 0 ? <span className="pill warn">{t.queued} · {queueDepth}</span> : null}
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/*" capture="user"
             onChange={onFile} style={{ display: "none" }} />
    </div>
  );
}
