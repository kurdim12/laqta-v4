import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Shell } from "../components/Shell";
import { useI18n } from "../i18n";
import { ApiError, call, messageFor } from "../api/client";
import { useSession } from "../state/useSession";

interface EventRow {
  id: string; slug: string; name: string; status: string;
  wall_frozen: boolean; panic_brand_only: boolean; intake_paused: boolean;
  ai_paused: boolean; banner_active: boolean;
  guest_mode: string; locale_default: string;
  ai_budget_usd: string | null; ai_spend_usd: string;
  max_generations: number; generations_used: number;
}
interface OperatorRow {
  id: string; username: string; display_name: string; booth: string; role: string; active: boolean;
}

const SWITCHES = [
  { key: "wallFrozen", field: "wall_frozen", label: "wallFrozen" },
  { key: "panicBrandOnly", field: "panic_brand_only", label: "panicBrandOnly" },
  { key: "intakePaused", field: "intake_paused", label: "intakePaused" },
  { key: "aiPaused", field: "ai_paused", label: "aiPaused" },
  { key: "bannerActive", field: "banner_active", label: "bannerActive" },
] as const;

export default function Admin() {
  const { t } = useI18n();
  const { session } = useSession();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [operators, setOperators] = useState<OperatorRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");
  const [opUser, setOpUser] = useState("");
  const [opName, setOpName] = useState("");
  const [opBooth, setOpBooth] = useState("A");
  const [opRole, setOpRole] = useState("operator");
  const [opPin, setOpPin] = useState("");

  const event = events.find((e) => e.id === selected) ?? null;

  const loadEvents = useCallback(async () => {
    try {
      const rows = await call<EventRow[]>("event.list");
      setEvents(rows ?? []);
      setSelected((s) => s ?? rows?.[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : "", t as unknown as Record<string, string>));
    }
  }, [t]);

  const loadOperators = useCallback(async (eventId: string) => {
    try {
      setOperators(await call<OperatorRow[]>("operator.list", { eventId }));
    } catch {
      setOperators([]);
    }
  }, []);

  useEffect(() => { void loadEvents(); }, [loadEvents]);
  useEffect(() => { if (selected) void loadOperators(selected); }, [selected, loadOperators]);

  async function run(fn: () => Promise<unknown>, okMessage?: string) {
    setBusy(true); setError(null); setOk(null);
    try {
      await fn();
      await loadEvents();
      if (selected) await loadOperators(selected);
      if (okMessage) setOk(okMessage);
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : "", t as unknown as Record<string, string>));
    } finally {
      setBusy(false);
    }
  }

  if (!session) return <Navigate to="/admin/login" replace />;
  if (session.kind !== "admin") return <Navigate to="/" replace />;

  const statusLabel = (s: string) =>
    s === "live" ? t.statusLive : s === "archived" ? t.statusArchived : t.statusDraft;

  return (
    <Shell title={t.surfaceAdmin}>
      <h1>{t.events}</h1>
      {error ? <div className="notice bad">{error}</div> : null}
      {ok ? <div className="notice ok">{ok}</div> : null}

      <table>
        <thead>
          <tr>
            <th>{t.eventName}</th><th>{t.eventSlug}</th><th>{t.status}</th><th></th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} style={e.id === selected ? { background: "var(--surface-2)" } : undefined}>
              <td>{e.name}</td>
              <td className="muted">{e.slug}</td>
              <td><span className={`pill ${e.status === "live" ? "ok" : ""}`}>{statusLabel(e.status)}</span></td>
              <td><button className="ghost" onClick={() => setSelected(e.id)}>{t.switches}</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{t.newEvent}</h2>
      <form
        className="row"
        onSubmit={(ev) => {
          ev.preventDefault();
          void run(async () => {
            await call("event.create", { slug: newSlug, name: newName });
            setNewSlug(""); setNewName("");
          });
        }}
      >
        <input style={{ maxWidth: 220 }} placeholder={t.eventSlugField} value={newSlug}
               onChange={(e) => setNewSlug(e.target.value.trim().toLowerCase())} required />
        <input style={{ maxWidth: 260 }} placeholder={t.eventName} value={newName}
               onChange={(e) => setNewName(e.target.value)} required />
        <button className="primary" type="submit" disabled={busy}>{t.create}</button>
      </form>

      {event ? (
        <>
          <h2>{t.switches} — {event.name}</h2>
          <p className="muted" style={{ fontSize: ".85rem", marginBlockStart: -4 }}>
            {t.surfaceWall}: #/wall/{event.slug} · {event.generations_used}/{event.max_generations} ·
            ${Number(event.ai_spend_usd).toFixed(2)}
            {event.ai_budget_usd ? ` / $${Number(event.ai_budget_usd).toFixed(2)}` : ""}
          </p>
          <div className="row">
            {SWITCHES.map((s) => {
              const on = Boolean((event as unknown as Record<string, boolean>)[s.field]);
              return (
                <button
                  key={s.key}
                  className={on ? "primary" : ""}
                  disabled={busy}
                  onClick={() =>
                    void run(() => call("event.switches", { eventId: event.id, [s.key]: !on }))
                  }
                >
                  {t[s.label as keyof typeof t]} {on ? "✓" : ""}
                </button>
              );
            })}
          </div>

          <h2>{t.operators}</h2>
          <table>
            <thead>
              <tr><th>{t.username}</th><th>{t.displayName}</th><th>{t.booth}</th><th>{t.role}</th><th></th></tr>
            </thead>
            <tbody>
              {operators.map((o) => (
                <tr key={o.id}>
                  <td>{o.username}</td><td>{o.display_name}</td><td>{o.booth}</td>
                  <td>{o.role === "admin" ? t.roleAdmin : t.roleOperator}</td>
                  <td>
                    <button className="ghost" disabled={busy}
                            onClick={() => void run(
                              () => call("operator.unlock", { eventId: event.id, username: o.username }),
                              t.unlocked,
                            )}>
                      {t.unlockOperator}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>{t.newOperator}</h2>
          <form
            className="row"
            onSubmit={(ev) => {
              ev.preventDefault();
              void run(async () => {
                await call("operator.create", {
                  eventId: event.id, username: opUser, displayName: opName,
                  booth: opBooth, role: opRole, pin: opPin,
                });
                setOpUser(""); setOpName(""); setOpPin("");
              });
            }}
          >
            <input style={{ maxWidth: 160 }} placeholder={t.username} value={opUser}
                   onChange={(e) => setOpUser(e.target.value.trim())} required />
            <input style={{ maxWidth: 180 }} placeholder={t.displayName} value={opName}
                   onChange={(e) => setOpName(e.target.value)} required />
            <input style={{ maxWidth: 90 }} placeholder={t.booth} value={opBooth}
                   onChange={(e) => setOpBooth(e.target.value)} required />
            <select style={{ maxWidth: 140 }} value={opRole} onChange={(e) => setOpRole(e.target.value)}>
              <option value="operator">{t.roleOperator}</option>
              <option value="admin">{t.roleAdmin}</option>
            </select>
            <input style={{ maxWidth: 120 }} type="password" inputMode="numeric" placeholder={t.pin}
                   value={opPin} onChange={(e) => setOpPin(e.target.value)} required />
            <button className="primary" type="submit" disabled={busy}>{t.addOperator}</button>
          </form>
        </>
      ) : null}
    </Shell>
  );
}
