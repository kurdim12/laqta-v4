import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shell } from "../components/Shell";
import { useI18n } from "../i18n";
import { ApiError, call, messageFor } from "../api/client";
import { useSession } from "../state/useSession";

interface LoginResult {
  outcome: string;
  token?: string;
  retryAfter?: string | null;
  admin?: { id: string; username: string; displayName: string };
}

export default function AdminLogin() {
  const { t } = useI18n();
  const { signIn } = useSession();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call<LoginResult>("admin.login", { username, password });
      if (r.outcome !== "ok" || !r.token) {
        setError(messageFor(r.outcome, t as unknown as Record<string, string>));
        return;
      }
      signIn({ token: r.token, kind: "admin", username: r.admin!.username, displayName: r.admin!.displayName });
      navigate("/admin");
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : "", t as unknown as Record<string, string>));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title={t.adminSignIn}>
      <div className="center">
        <form className="panel card" onSubmit={submit}>
          <h1 style={{ fontSize: "1.2rem" }}>{t.adminSignIn}</h1>
          <div className="spacer" style={{ height: 10 }} />
          {error ? <div className="notice bad">{error}</div> : null}
          <label>
            <span>{t.username}</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
          </label>
          <label>
            <span>{t.password}</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                   autoComplete="current-password" required />
          </label>
          <button className="primary" type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy ? t.signingIn : t.signIn}
          </button>
        </form>
      </div>
    </Shell>
  );
}
