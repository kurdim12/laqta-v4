import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "../i18n";
import { loadSession, saveSession } from "../api/client";
import { useOnline } from "../state/useOnline";

/** The frame every signed-in surface sits in: identity, language, connection state. */
export function Shell({ title, children, wide = false }: {
  title?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t, toggle } = useI18n();
  const online = useOnline();
  const navigate = useNavigate();
  const session = loadSession();

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brandmark" style={{ color: "inherit" }}>
          {t.appName}
          {title ? <small>{title}</small> : null}
        </Link>
        <div className="grow" />
        <span className={`pill ${online ? "ok" : "bad"}`}>{online ? t.online : t.offline}</span>
        <button className="ghost" onClick={toggle} aria-label="language">{t.language}</button>
        {session ? (
          <button
            className="ghost"
            onClick={() => {
              saveSession(null);
              navigate("/");
            }}
          >
            {t.signOut}
          </button>
        ) : null}
      </header>
      <main className={wide ? "main wide" : "main"}>{children}</main>
    </div>
  );
}
