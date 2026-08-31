import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Shell } from "../components/Shell";
import { galleryLink } from "../components/Qr";
import { useI18n } from "../i18n";
import { ApiError, call, messageFor } from "../api/client";

interface GuestPhoto { id: string; createdAt: string; thumbUrl: string | null; downloadUrl: string | null }
interface GuestResult { outcome: string; photos: GuestPhoto[] }

/** Saving a photo to the guest's phone.
 *
 *  The markup below has always carried `<a download>`, and `download` is IGNORED for a
 *  cross-origin href — which every one of these is, because the photo is served from Supabase
 *  Storage and the app is not. So the attribute did nothing: the tap opened the JPEG in a new
 *  tab named after a UUID, and the guest was left to long-press it. In an in-app browser
 *  (Instagram, WhatsApp — where a scanned QR usually lands) that new tab can dead-end with no
 *  save affordance at all.
 *
 *  Fetching the bytes and saving a blob fixes both halves: a `blob:` URL is same-origin, so
 *  `download` is honoured and the file gets a name a person recognises. If the fetch fails —
 *  CORS, a dead uplink, an old browser that ignores `download` on blobs too — nothing is
 *  swallowed: the handler returns false and the anchor's own navigation proceeds, which is
 *  exactly the behaviour that shipped before. The enhancement can only add.
 */
async function saveToDevice(url: string, filename: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked late: Safari reads the blob after the click returns, and revoking synchronously
    // saves a zero-byte file.
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
    return true;
  } catch {
    return false;
  }
}

/** A name the guest will recognise in their downloads folder, instead of a storage UUID. */
function photoFilename(code: string, index: number): string {
  return `laqta-${code.toLowerCase()}-${index + 1}.jpg`;
}

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
  // Which photo is being fetched, so the tapped button says so instead of looking dead on a
  // venue uplink where a full-size photo takes a few seconds.
  const [saving, setSaving] = useState<string | null>(null);

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
              {photos.map((p, i) => {
                const name = photoFilename(openedCode ?? "photo", i);
                return (
                  <div className="tile" key={p.id}>
                    {p.thumbUrl ? <img src={p.thumbUrl} alt="" /> : null}
                    <div className="actions">
                      {p.downloadUrl ? (
                        // The anchor stays real: it is the fallback if the blob save fails, and
                        // it is what a long-press acts on.
                        <a
                          href={p.downloadUrl}
                          download={name}
                          data-download={name}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => {
                            e.preventDefault();
                            setSaving(p.id);
                            void saveToDevice(p.downloadUrl!, name).then((saved) => {
                              setSaving(null);
                              // Nothing was saved: let the link do what it always did.
                              if (!saved) window.open(p.downloadUrl!, "_blank", "noreferrer");
                            });
                          }}
                        >
                          <button disabled={saving === p.id}>
                            {saving === p.id ? t.loading : t.download}
                          </button>
                        </a>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )
      ) : null}
    </Shell>
  );
}
