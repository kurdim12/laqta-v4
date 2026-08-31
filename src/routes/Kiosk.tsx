import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { useI18n } from "../i18n";
import { useSession } from "../state/useSession";
import { deviceId } from "../api/photo";
import { enqueue, startSync, subscribe, type OutboxItem } from "../offline/outbox";
import { warmCutout } from "../api/cutout";
import { call, ApiError, messageFor } from "../api/client";
import { Qr, galleryLink } from "../components/Qr";

// The iPad self-serve kiosk (feature C): a staff member signs the device in once; from then on
// it is a guest-facing full-screen camera with a square framing guide. Shots are auto-cropped
// square and land UNAPPROVED in the moderation queue — the kiosk trusts nobody, including
// itself. Same outbox as the booth, so the offline law covers this surface identically.
//
// Under the registration guest mode (feature H) the kiosk grows a first screen: the guest
// registers, gets their code, and every shot they take is bound to them at the shutter. The
// registration itself needs the network once; from then on the binding is a field riding the
// outbox, so the shots themselves keep the full offline law.

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

interface KioskGuest { guestId: string; code: string }

export default function Kiosk() {
  const { t, toggle, locale } = useI18n();
  const { session } = useSession();
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [shotError, setShotError] = useState<string | null>(null);
  const [queueDepth, setQueueDepth] = useState(0);
  const [guestMode, setGuestMode] = useState<string>("wall_only");
  const [guest, setGuest] = useState<KioskGuest | null>(null);
  const [farewell, setFarewell] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void warmCutout();
    const stopSync = startSync();
    const unsub = subscribe((items: OutboxItem[]) =>
      setQueueDepth(items.filter((i) => i.state !== "done").length));

    const beat = () =>
      call("station.heartbeat", {
        deviceId: deviceId(), kind: "kiosk", label: "Kiosk",
        queueDepth, appVersion: "phase-5",
      }).catch(() => { /* the kiosk keeps shooting regardless */ });
    beat();
    const timer = setInterval(beat, 3000);
    return () => { stopSync(); unsub(); clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!session?.eventSlug) return;
    call<{ guest_mode?: string } | null>("event.get", { slug: session.eventSlug })
      .then((e) => setGuestMode(e?.guest_mode ?? "wall_only"))
      .catch(() => { /* stays wall_only: plain kiosk, still shooting */ });
  }, [session?.eventSlug]);

  async function register(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ outcome: string; guest_id: string | null; code: string | null }>(
        "guest.register", { displayName: name, phone: phone || null, locale, consent });
      if (r.outcome !== "ok" || !r.guest_id || !r.code) {
        setError(messageFor(r.outcome === "rate_limited" ? "codeRateLimited" : r.outcome,
                            t as unknown as Record<string, string>));
        return;
      }
      setGuest({ guestId: r.guest_id, code: r.code });
      setName(""); setPhone(""); setConsent(false);
    } catch (err) {
      setError(err instanceof ApiError && err.isOffline
        ? t.needConnection
        : messageFor(err instanceof ApiError ? err.code : "", t as unknown as Record<string, string>));
    } finally {
      setBusy(false);
    }
  }

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
        guestId: guest?.guestId,
      });
      setState("done");
      setTimeout(() => setState("idle"), 3500);
    } catch (err) {
      // Never silent. An unattended tablet that returns to "tap to shoot" after
      // eating a shot is how a guest walks away believing they were photographed.
      setState("idle");
      setShotError(t.captureFailed);
      void call("ops.report", {
        service: "kiosk", event: "capture_failed", ok: false,
        code: "SHUTTER", error: String(err).slice(0, 200), deviceId: deviceId(),
      }).catch(() => { /* the guest's shot matters more than the report */ });
    }
  }

  if (!session) return <Navigate to="/operator/login" replace />;
  if (session.kind !== "operator") return <Navigate to="/" replace />;

  const needsRegistration = guestMode === "registration" && !guest;

  return (
    <div className="wall" style={{ background: "var(--bg)" }}>
      <div style={{ position: "absolute", insetBlockStart: 14, insetInlineEnd: 14, zIndex: 5 }}>
        <button className="ghost" onClick={toggle}>{t.language}</button>
      </div>

      {farewell && guest ? (
        // The goodbye screen: the code that opens everything this guest just shot.
        <div className="wall-empty" style={{ flexDirection: "column", gap: 14, display: "flex",
                                             alignItems: "center", justifyContent: "center" }}>
          <h1 style={{ margin: 0 }}>{t.yourCode}</h1>
          <p className="muted" style={{ margin: 0 }}>{t.keepCode}</p>
          <p data-code={guest.code}
             style={{ fontFamily: "ui-monospace, monospace", fontSize: "1.7rem",
                      letterSpacing: ".15em", margin: 0, textAlign: "center",
                      overflowWrap: "anywhere" }}>
            {guest.code}
          </p>
          <Qr value={galleryLink(guest.code)} size={240} />
          <button className="primary" data-next-guest
                  onClick={() => { setGuest(null); setFarewell(false); }}>
            {t.nextGuest}
          </button>
        </div>
      ) : needsRegistration ? (
        <div className="wall-empty" style={{ display: "flex", alignItems: "center",
                                             justifyContent: "center", padding: 24 }}>
          <form onSubmit={register} style={{ width: "min(440px, 92vw)" }} data-kiosk-register>
            <h1 style={{ marginBlockStart: 0 }}>{t.registerTitle}</h1>
            <p className="muted">{t.registerFirst}</p>
            <label>
              <span>{t.yourName}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label>
              <span>{t.yourPhone}</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)}
                     inputMode="tel" autoComplete="tel" />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={consent}
                     onChange={(e) => setConsent(e.target.checked)} required />
              <span style={{ margin: 0 }}>{t.consentLabel}</span>
            </label>
            <button className="primary" type="submit" disabled={busy}>
              {busy ? t.loading : t.registerCta}
            </button>
            {error ? <div className="notice bad" style={{ marginBlockStart: 12 }}>{error}</div> : null}
          </form>
        </div>
      ) : (
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

          {shotError ? <div className="notice bad" data-shot-error>{shotError}</div> : null}
          {queueDepth > 0 ? (
            <span className="pill warn">{t.queued} · {queueDepth}</span>
          ) : null}

          {guest ? (
            <button className="ghost" data-kiosk-finish onClick={() => setFarewell(true)}>
              {t.finishShooting}
            </button>
          ) : null}
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/*" capture="user"
             onChange={onFile} style={{ display: "none" }} />
    </div>
  );
}
