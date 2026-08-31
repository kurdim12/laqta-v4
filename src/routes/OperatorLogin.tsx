import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shell } from "../components/Shell";
import { useI18n } from "../i18n";
import { ApiError, call, messageFor , expiryOf } from "../api/client";
import { useSession } from "../state/useSession";
import { deviceId } from "../api/photo";

interface LoginResult {
  outcome: string;
  token?: string;
  retryAfter?: string | null;
  operator?: {
    id: string; eventId: string; username: string;
    displayName: string; booth: string; role: string;
  };
}

export default function OperatorLogin() {
  const { t } = useI18n();
  const { signIn } = useSession();
  const navigate = useNavigate();
  const [eventSlug, setEventSlug] = useState("");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setRetryAfter(null);
    try {
      const r = await call<LoginResult>("operator.login", {
        eventSlug, username, pin, deviceId: deviceId(),
      });
      if (r.outcome !== "ok" || !r.token) {
        setError(messageFor(r.outcome, t as unknown as Record<string, string>));
        // A locked-out operator is told when they may try again, rather than being left to
        // guess and keep hammering the counter that is locking them out.
        setRetryAfter(r.retryAfter ?? null);
        return;
      }
      signIn({
        token: r.token, kind: "operator",
        username: r.operator!.username, displayName: r.operator!.displayName,
        eventId: r.operator!.eventId, eventSlug, booth: r.operator!.booth, role: r.operator!.role,
        // Stored so the station can tell "expired" from "broken" without asking the server.
        exp: expiryOf(r.token),
      });
      navigate("/booth");
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : "", t as unknown as Record<string, string>));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title={t.operatorSignIn}>
      <div className="center">
        <form className="panel card" onSubmit={submit}>
          <h1 style={{ fontSize: "1.2rem" }}>{t.operatorSignIn}</h1>
          <div className="spacer" style={{ height: 10 }} />
          {error ? (
            <div className="notice bad">
              {error}
              {retryAfter ? (
                <div style={{ marginBlockStart: 6, fontSize: ".85rem" }}>
                  {t.lockedOutUntil}: {new Date(retryAfter).toLocaleTimeString()}
                </div>
              ) : null}
            </div>
          ) : null}
          <label>
            <span>{t.eventSlug}</span>
            <input value={eventSlug} onChange={(e) => setEventSlug(e.target.value.trim().toLowerCase())}
                   placeholder="lynk-and-co" required />
          </label>
          <label>
            <span>{t.username}</span>
            <input value={username} onChange={(e) => setUsername(e.target.value.trim())}
                   autoComplete="username" required />
          </label>
          <label>
            <span>{t.pin}</span>
            <input type="password" inputMode="numeric" value={pin}
                   onChange={(e) => setPin(e.target.value)} autoComplete="current-password" required />
          </label>
          <button className="primary" type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy ? t.signingIn : t.signIn}
          </button>
        </form>
      </div>
    </Shell>
  );
}
