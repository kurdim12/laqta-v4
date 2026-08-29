import { useEffect, useRef } from "react";
import QRCode from "qrcode";

/** A QR code drawn locally, on a canvas, from the bundled encoder. Nothing leaves the device
 *  to render one — a code must be showable in a venue whose internet just died, because the
 *  moment the operator most needs to hand a guest their code is exactly that moment. */
export function Qr({ value, size = 220 }: { value: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    QRCode.toCanvas(ref.current, value, { width: size, margin: 1 }).catch(() => {
      /* an undrawable QR leaves the text code, which is the credential anyway */
    });
  }, [value, size]);

  return (
    <canvas
      ref={ref}
      data-qr={value}
      style={{ borderRadius: 10, background: "#fff", padding: 6, maxWidth: "100%" }}
    />
  );
}

/** The gallery link a code opens. Hash-routed on purpose: this URL must work pasted into any
 *  phone browser against a drag-and-drop static host. */
export function galleryLink(code: string): string {
  return `${location.origin}${location.pathname}#/guest?code=${code}`;
}
