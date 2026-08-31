import { useEffect, useState } from "react";
import { Shell } from "../components/Shell";
import { useI18n } from "../i18n";
import { deviceId } from "../api/photo";
import { list, type OutboxItem } from "../offline/outbox";
import { call } from "../api/client";

// The screen an operator opens when something did not work and somebody needs to know exactly
// what. It reads the device's own outbox rather than asking the server, so it still tells the
// truth during an outage — which is precisely when it is needed. Nothing here is a control: it
// cannot retry, delete or change anything, so handing a guest-facing tablet to a bystander on
// this screen is safe.

interface Health { api: boolean; database: boolean; storage: boolean; openrouter: boolean; anam: boolean }

export default function Diag() {
  const { t } = useI18n();
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const read = () => void list().then(setItems);
    read();
    const timer = setInterval(read, 2000);
    call<Health>("ops.health", {}).then(setHealth).catch(() => setHealth(null));
    return () => clearInterval(timer);
  }, []);

  const waiting = items.filter((i) => i.state !== "done");
  const report = [
    `device: ${deviceId()}`,
    `online: ${navigator.onLine}`,
    `api: ${health ? "reachable" : "unreachable"}`,
    `waiting: ${waiting.length}`,
    ...waiting.slice(0, 10).map((i) =>
      `  ${i.id.slice(0, 8)} ${i.source} attempts=${i.attempts} hard=${i.hardFailures ?? 0} ` +
      `bytes=${i.file?.size ?? 0} type=${i.file?.type || "?"} last=${i.lastError ?? "-"}`),
  ].join("\n");

  return (
    <Shell title={t.diagTitle}>
      <h1>{t.diagTitle}</h1>
      <p className="lede">{t.diagHint}</p>

      <table>
        <tbody>
          <tr><td>{t.diagDevice}</td><td className="muted" data-diag-device>{deviceId()}</td></tr>
          <tr><td>{t.online}</td><td>
            <span className={`pill ${navigator.onLine ? "ok" : "bad"}`}>
              {navigator.onLine ? t.online : t.offline}
            </span>
          </td></tr>
          <tr><td>{t.diagQueue}</td><td data-diag-waiting>{waiting.length}</td></tr>
        </tbody>
      </table>

      {health ? (
        <div className="row" style={{ marginBlockStart: 12 }}>
          {(Object.keys(health) as (keyof Health)[]).map((k) => (
            <span key={k} className={`pill ${health[k] ? "ok" : "warn"}`}>
              {k} · {health[k] ? t.configHealth : t.configMissing}
            </span>
          ))}
        </div>
      ) : null}

      {waiting.length === 0 ? (
        <p className="muted" style={{ marginBlockStart: 20 }}>{t.diagNone}</p>
      ) : (
        <>
          <h2>{t.diagLastError}</h2>
          <table>
            <tbody>
              {waiting.slice(0, 10).map((i) => (
                <tr key={i.id}>
                  <td className="muted">{i.source}</td>
                  <td>{i.attempts}</td>
                  <td className="muted" style={{ overflowWrap: "anywhere" }}>{i.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <pre style={{ marginBlockStart: 18, padding: 12, background: "var(--surface-2)",
                    borderRadius: 10, overflowX: "auto", fontSize: ".78rem" }}
           data-diag-report>{report}</pre>
      <button onClick={() => {
        navigator.clipboard?.writeText(report).then(
          () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
          () => { /* the text is on screen either way */ },
        );
      }}>
        {copied ? t.copied : t.diagCopy}
      </button>
    </Shell>
  );
}
