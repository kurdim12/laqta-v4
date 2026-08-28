import { useState } from "react";
import { Shell } from "../components/Shell";
import { useI18n } from "../i18n";
import { ApiError, call, messageFor } from "../api/client";

interface GuestPhoto { id: string; createdAt: string; thumbUrl: string | null; downloadUrl: string | null }
interface GuestResult { outcome: string; photos: GuestPhoto[] }

/** Guests never sign in. They hold a code, and the code is the whole credential — which is why
 *  it is long, and why the lookup is rate limited in the database rather than here. */
export default function Guest() {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [photos, setPhotos] = useState<GuestPhoto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setPhotos(null);
    try {
      const r = await call<GuestResult>("guest.photos", { code: code.trim().toUpperCase() });
      if (r.outcome !== "ok") {
        setError(messageFor(r.outcome, t as unknown as Record<string, string>));
        return;
      }
      setPhotos(r.photos);
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : "", t as unknown as Record<string, string>));
    } finally {
      setBusy(false);
    }
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
          <div className="tiles" style={{ marginBlockStart: 20 }}>
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
        )
      ) : null}
    </Shell>
  );
}
