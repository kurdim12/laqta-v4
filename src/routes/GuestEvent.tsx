import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Shell } from "../components/Shell";
import { Qr, galleryLink } from "../components/Qr";
import { ShareRow } from "./Guest";
import { useI18n } from "../i18n";
import { call, messageFor, ApiError } from "../api/client";

interface PublicEvent {
  slug: string; name: string; name_ar: string | null; name_en: string | null;
  guest_mode: string; brand_primary: string | null;
}

interface Registered { outcome: string; guest_id: string | null; code: string | null }

/** The per-event guest landing — the page the printed QR points at. What it shows is decided
 *  by the event's guest mode, which lives on the events row (law 5) and is enforced again in
 *  the database: this page choosing wrong could still not mint a code the mode forbids. */
export default function GuestEvent() {
  const { t, locale } = useI18n();
  const { slug } = useParams<{ slug: string }>();
  const [event, setEvent] = useState<PublicEvent | null | undefined>(undefined);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    call<PublicEvent | null>("event.get", { slug })
      .then((e) => setEvent(e ?? null))
      .catch(() => setEvent(null));
  }, [slug]);

  async function register(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call<Registered>("guest.register", {
        slug, displayName: name, phone: phone || null, locale, consent,
      });
      if (r.outcome !== "ok" || !r.code) {
        setError(messageFor(r.outcome === "rate_limited" ? "codeRateLimited" : r.outcome,
                            t as unknown as Record<string, string>));
        return;
      }
      setCode(r.code);
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : "", t as unknown as Record<string, string>));
    } finally {
      setBusy(false);
    }
  }

  if (event === undefined) {
    return <Shell title={t.guestTitle}><p className="muted">{t.loading}</p></Shell>;
  }
  if (event === null) {
    return <Shell title={t.guestTitle}><div className="notice bad">{t.somethingWentWrong}</div></Shell>;
  }

  const eventName = (locale === "ar" ? event.name_ar : event.name_en) || event.name;

  return (
    <Shell title={eventName}>
      <h1>{eventName}</h1>

      {event.guest_mode === "wall_only" ? (
        <p className="lede" data-guest-mode="wall_only">{t.guestModeWall}</p>
      ) : null}

      {event.guest_mode === "code_per_shot" ? (
        // The operator hands the guest their code at the booth; this page just opens it.
        <div data-guest-mode="code_per_shot">
          <p className="lede">{t.enterCode}</p>
          <Link to="/guest"><button className="primary">{t.openGallery}</button></Link>
        </div>
      ) : null}

      {event.guest_mode === "registration" ? (
        code ? (
          <div data-guest-mode="registration">
            <h2>{t.yourCode}</h2>
            <p className="muted">{t.keepCode}</p>
            <p data-code={code}
               style={{ fontFamily: "ui-monospace, monospace", fontSize: "1.6rem",
                        letterSpacing: ".14em", overflowWrap: "anywhere" }}>
              {code}
            </p>
            <Qr value={galleryLink(code)} />
            <div className="row" style={{ marginBlockStart: 12 }}>
              <Link to={`/guest?code=${code}`}>
                <button className="primary">{t.openMyGallery}</button>
              </Link>
            </div>
            <ShareRow code={code} />
          </div>
        ) : (
          <form onSubmit={register} style={{ maxWidth: 440 }} data-guest-mode="registration">
            <h2>{t.registerTitle}</h2>
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
          </form>
        )
      ) : null}

      {error ? <div className="notice bad" style={{ marginBlockStart: 16 }}>{error}</div> : null}
    </Shell>
  );
}
