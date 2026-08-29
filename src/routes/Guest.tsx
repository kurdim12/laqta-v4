import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Shell } from "../components/Shell";
import { galleryLink } from "../components/Qr";
import { useI18n } from "../i18n";
import { ApiError, call, messageFor } from "../api/client";

interface GuestPhoto { id: string; createdAt: string; thumbUrl: string | null; downloadUrl: string | null }
interface GuestResult { outcome: string; photos: GuestPhoto[] }

/** The delivery row: the guest sends their own gallery to themselves. WhatsApp and SMS links
 *  open the phone's own apps with the message prefilled — the sending path that actually
 *  exists in every guest's pocket, with no gateway, no credential, and nothing to configure
 *  (law 8 has nothing to report because there is nothing that can be unconfigured). */
export function ShareRow({ code }: { code: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const link = galleryLink(code);
  const text = `${t.shareMessage} ${link}`;

  return (
    <div className="row" style={{ marginBlockStart: 12 }}>
      <a data-share="whatsapp" href={`https://wa.me/?text=${encodeURIComponent(text)}`}
         target="_blank" rel="noreferrer">
        <button type="button">{t.shareWhatsApp}</button>
      </a>
      <a data-share="sms" href={`sms:?&body=${encodeURIComponent(text)}`}>
        <button type="button">{t.shareSms}</button>
      </a>
      <button
        type="button"
        data-share="copy"
        onClick={() => {
          navigator.clipboard?.writeText(link).then(
            () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
            () => { /* an unwritable clipboard leaves the visible code, which is enough */ },
          );
        }}
      >
        {copied ? t.copied : t.copyLink}
      </button>
    </div>
  );
}

/** Guests never sign in. They hold a code, and the code is the whole credential — which is why
 *  it is long, and why the lookup is rate limited in the database rather than here. A QR that
 *  encodes ...#/guest?code=XXXX lands here and opens itself. */
export default function Guest() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const [code, setCode] = useState(() => (params.get("code") ?? "").toUpperCase());
  const [openedCode, setOpenedCode] = useState<string | null>(null);
  const [photos, setPhotos] = useState<GuestPhoto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (c: string) => {
    setBusy(true);
    setError(null);
    setPhotos(null);
    try {
      const r = await call<GuestResult>("guest.photos", { code: c });
      if (r.outcome !== "ok") {
        setError(messageFor(r.outcome, t as unknown as Record<string, string>));
        return;
      }
      setPhotos(r.photos);
      setOpenedCode(c);
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : "", t as unknown as Record<string, string>));
    } finally {
      setBusy(false);
    }
  }, [t]);

  // A scanned QR should not also demand a tap on "Open".
  useEffect(() => {
    const fromLink = (params.get("code") ?? "").trim().toUpperCase();
    if (fromLink.length === 14) void open(fromLink);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await open(code.trim().toUpperCase());
  }

  return (
    <Shell title={t.guestTitle}>
      <h1>{t.guestTitle}</h1>
      <form onSubmit={submit} style={{ maxWidth: 420 }}>
        <label>
          <span>{t.enterCode}</span>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
                 placeholder={t.codePlaceholder} maxLength={14} autoCapitalize="characters"
                 spellCheck={false} required
                 style={{ letterSpacing: ".18em", fontFamily: "ui-monospace, monospace" }} />
        </label>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? t.loading : t.openGallery}
        </button>
      </form>

      {error ? <div className="notice bad" style={{ marginBlockStart: 16 }}>{error}</div> : null}

      {photos ? (
        photos.length === 0 ? (
          <p className="muted" style={{ marginBlockStart: 20 }}>{t.noPhotosYet}</p>
        ) : (
          <>
            {openedCode ? <ShareRow code={openedCode} /> : null}
            <div className="tiles" style={{ marginBlockStart: 16 }}>
              {photos.map((p) => (
                <div className="tile" key={p.id}>
                  {p.thumbUrl ? <img src={p.thumbUrl} alt="" /> : null}
                  <div className="actions">
                    {p.downloadUrl ? (
                      <a href={p.downloadUrl} download target="_blank" rel="noreferrer">
                        <button>{t.download}</button>
                      </a>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </>
        )
      ) : null}
    </Shell>
  );
}
