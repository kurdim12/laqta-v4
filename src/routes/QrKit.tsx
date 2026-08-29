import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Qr } from "../components/Qr";
import { useI18n } from "../i18n";
import { call } from "../api/client";

interface PublicEvent {
  slug: string; name: string; name_ar: string | null; name_en: string | null;
  brand_primary: string | null;
}

/** The printable QR kit (feature A): one page per event, printed and stood on tables. Every
 *  QR encodes a hash-routed URL of this same deployment, so the kit that was printed for the
 *  venue works against whatever static host the folder was dropped on. */
export default function QrKit() {
  const { t, locale } = useI18n();
  const { slug } = useParams<{ slug: string }>();
  const [event, setEvent] = useState<PublicEvent | null>(null);

  useEffect(() => {
    if (!slug) return;
    call<PublicEvent | null>("event.get", { slug }).then((e) => setEvent(e ?? null)).catch(() => setEvent(null));
  }, [slug]);

  if (!slug) return null;

  const base = `${location.origin}${location.pathname}`;
  const links = [
    { key: "guest", label: t.qrGuest, url: `${base}#/g/${slug}` },
    { key: "wall", label: t.qrWall, url: `${base}#/wall/${slug}` },
    { key: "kiosk", label: t.qrKiosk, url: `${base}#/kiosk` },
  ];
  const eventName = event ? ((locale === "ar" ? event.name_ar : event.name_en) || event.name) : slug;

  return (
    <div style={{ padding: 24, background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>{eventName} — {t.qrKit}</h1>
        <button className="primary no-print" onClick={() => window.print()}>{t.printKit}</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                    gap: 28, marginBlockStart: 28 }}>
        {links.map((l) => (
          <div key={l.key} data-kit={l.key}
               style={{ border: "1px solid #ccc", borderRadius: 14, padding: 20,
                        display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
                        pageBreakInside: "avoid" }}>
            <strong style={{ fontSize: "1.1rem", textAlign: "center" }}>{l.label}</strong>
            <Qr value={l.url} size={260} />
            <span style={{ fontSize: ".72rem", color: "#666", overflowWrap: "anywhere",
                           textAlign: "center" }}>{l.url}</span>
          </div>
        ))}
      </div>

      <style>{`@media print { .no-print { display: none } }`}</style>
    </div>
  );
}
