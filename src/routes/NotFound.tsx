import { Link } from "react-router-dom";
import { Shell } from "../components/Shell";
import { useI18n } from "../i18n";

export default function NotFound() {
  const { t } = useI18n();
  return (
    <Shell>
      <div className="center">
        <div className="panel" style={{ textAlign: "center" }}>
          <h1>404</h1>
          <p className="lede">{t.somethingWentWrong}</p>
          <Link to="/"><button className="primary">{t.back}</button></Link>
        </div>
      </div>
    </Shell>
  );
}
