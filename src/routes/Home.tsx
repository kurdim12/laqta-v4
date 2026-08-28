import { Link } from "react-router-dom";
import { Shell } from "../components/Shell";
import { useI18n } from "../i18n";
import { useSession } from "../state/useSession";

export default function Home() {
  const { t } = useI18n();
  const { session } = useSession();

  const surfaces = [
    { to: session?.kind === "admin" ? "/admin" : "/admin/login", title: t.surfaceAdmin, hint: t.surfaceAdminHint },
    { to: session?.kind === "operator" ? "/booth" : "/operator/login", title: t.surfaceBooth, hint: t.surfaceBoothHint },
    { to: session?.kind === "operator" ? "/queue" : "/operator/login", title: t.surfaceQueue, hint: t.surfaceQueueHint },
    { to: "/guest", title: t.surfaceGuest, hint: t.surfaceGuestHint },
  ];

  return (
    <Shell>
      <h1>{t.appName}</h1>
      <p className="lede">{t.tagline}</p>
      <h2>{t.chooseSurface}</h2>
      <div className="grid">
        {surfaces.map((s) => (
          <Link key={s.to + s.title} className="card" to={s.to}>
            <h3>{s.title}</h3>
            <p>{s.hint}</p>
          </Link>
        ))}
      </div>
      <div className="spacer" />
      <p className="muted" style={{ fontSize: ".85rem" }}>
        {t.surfaceWall}: /wall/&lt;{t.eventSlug.toLowerCase()}&gt;
      </p>
    </Shell>
  );
}
