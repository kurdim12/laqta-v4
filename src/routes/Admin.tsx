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
  wall_config: { led?: { columns?: number; rows?: number; cycleSeconds?: number; brandPattern?: string; cutoutPattern?: string } } | null;
  ai_prompt: string; ai_model: string; ai_allowed_models: string[];
  ai_est_cost_usd: string;
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
  const [ledCols, setLedCols] = useState(6);
  const [ledRows, setLedRows] = useState(3);
  const [ledCycle, setLedCycle] = useState(8);
  const [ledPattern, setLedPattern] = useState("corners");
  const [ledCutouts, setLedCutouts] = useState("none");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiBudget, setAiBudget] = useState("");
  const [aiEst, setAiEst] = useState("0.04");
  const [aiMax, setAiMax] = useState(1000);
  const [brandNameEn, setBrandNameEn] = useState("");
  const [brandNameAr, setBrandNameAr] = useState("");
  const [brandLocale, setBrandLocale] = useState("ar");
  const [brandPrimary, setBrandPrimary] = useState("#e8c07a");
  const [brandSecondary, setBrandSecondary] = useState("#111111");

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

  // The layout form always shows what the event actually has, not what was last typed.
  useEffect(() => {
    const led = events.find((e) => e.id === selected)?.wall_config?.led;
    setLedCols(Number(led?.columns) || 6);
    setLedRows(Number(led?.rows) || 3);
    setLedCycle(Number(led?.cycleSeconds) || 8);
    setLedPattern(typeof led?.brandPattern === "string" ? led.brandPattern : "corners");
    setLedCutouts(led?.cutoutPattern === "row" ? "row" : "none");
    const ev = events.find((e) => e.id === selected);
    setAiPrompt(ev?.ai_prompt ?? "");
    setAiModel(ev?.ai_model ?? "");
    setAiBudget(ev?.ai_budget_usd != null ? String(ev.ai_budget_usd) : "");
    setAiEst(ev?.ai_est_cost_usd != null ? String(ev.ai_est_cost_usd) : "0.04");
    setAiMax(ev?.max_generations ?? 1000);
  }, [selected, events]);

  // The branding form always shows what the event actually has; the public shape is the one
  // source that carries the bilingual names and colors.
  useEffect(() => {
    const ev = events.find((e) => e.id === selected);
    if (!ev) return;
    call<{ name_en?: string | null; name_ar?: string | null; locale_default?: string;
           brand_primary?: string | null; brand_secondary?: string | null } | null>(
      "event.get", { slug: ev.slug })
      .then((p) => {
        if (!p) return;
        setBrandNameEn(p.name_en ?? "");
        setBrandNameAr(p.name_ar ?? "");
        setBrandLocale(p.locale_default ?? "ar");
        setBrandPrimary(p.brand_primary ?? "#e8c07a");
        setBrandSecondary(p.brand_secondary ?? "#111111");
      })
      .catch(() => { /* the form keeps its last values; saving still round-trips */ });
  }, [selected, events]);

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
            {t.wallGrid}: #/wall/{event.slug} · {t.wallLed}: #/wall/{event.slug}/led ·{" "}
            {t.wallLightbox}: #/wall/{event.slug}/lightbox · {t.qrKit}: #/qr/{event.slug} ·{" "}
            {event.generations_used}/{event.max_generations} ·
            ${Number(event.ai_spend_usd).toFixed(2)}
            {event.ai_budget_usd ? ` / $${Number(event.ai_budget_usd).toFixed(2)}` : ""}
          </p>

          <div className="row" style={{ alignItems: "center" }}>
            <label style={{ margin: 0 }}>
              <span>{t.guestModeLabel}</span>
              <select
                style={{ maxWidth: 200 }}
                value={event.guest_mode}
                disabled={busy}
                onChange={(e) =>
                  void run(() => call("event.branding", {
                    eventId: event.id, guestMode: e.target.value,
                  }), t.saved)
                }
              >
                <option value="wall_only">{t.modeWallOnly}</option>
                <option value="code_per_shot">{t.modeCodePerShot}</option>
                <option value="registration">{t.modeRegistration}</option>
              </select>
            </label>
            {event.status === "draft" ? (
              <button className="primary" disabled={busy}
                      onClick={() => void run(() => call("event.status", {
                        slug: event.slug, status: "live",
                      }), t.saved)}>
                {t.goLive}
              </button>
            ) : null}
            {event.status !== "archived" ? (
              <button disabled={busy}
                      onClick={() => {
                        // Archived is terminal in the database; make the tap mean it.
                        if (window.confirm(`${t.archiveEvent}: ${event.name}?`)) {
                          void run(() => call("event.status", {
                            slug: event.slug, status: "archived",
                          }), t.saved);
                        }
                      }}>
                {t.archiveEvent}
              </button>
            ) : null}
          </div>

          <h2>{t.branding}</h2>
          <form
            className="row"
            onSubmit={(ev) => {
              ev.preventDefault();
              void run(() => call("event.branding", {
                eventId: event.id,
                nameEn: brandNameEn || null,
                nameAr: brandNameAr || null,
                localeDefault: brandLocale,
                brandPrimary, brandSecondary,
              }), t.saved);
            }}
          >
            <label style={{ margin: 0 }}>
              <span>{t.nameEnLabel}</span>
              <input style={{ maxWidth: 200 }} value={brandNameEn}
                     onChange={(e) => setBrandNameEn(e.target.value)} />
            </label>
            <label style={{ margin: 0 }}>
              <span>{t.nameArLabel}</span>
              <input style={{ maxWidth: 200 }} dir="rtl" value={brandNameAr}
                     onChange={(e) => setBrandNameAr(e.target.value)} />
            </label>
            <label style={{ margin: 0 }}>
              <span>{t.localeDefaultLabel}</span>
              <select style={{ maxWidth: 110 }} value={brandLocale}
                      onChange={(e) => setBrandLocale(e.target.value)}>
                <option value="ar">العربية</option>
                <option value="en">English</option>
              </select>
            </label>
            <label style={{ margin: 0 }}>
              <span>{t.brandPrimaryLabel}</span>
              <input type="color" style={{ maxWidth: 70, padding: 2, height: 38 }} value={brandPrimary}
                     onChange={(e) => setBrandPrimary(e.target.value)} />
            </label>
            <label style={{ margin: 0 }}>
              <span>{t.brandSecondaryLabel}</span>
              <input type="color" style={{ maxWidth: 70, padding: 2, height: 38 }} value={brandSecondary}
                     onChange={(e) => setBrandSecondary(e.target.value)} />
            </label>
            <label style={{ margin: 0 }}>
              <span>{t.brandLogo}</span>
              <input type="file" accept="image/*" style={{ maxWidth: 230 }}
                     onChange={(e) => {
                       const f = e.target.files?.[0];
                       e.target.value = "";
                       if (!f) return;
                       void run(async () => {
                         const target = await call<{ path: string; uploadUrl: string }>(
                           "event.brandingUploadUrl", { eventId: event.id });
                         const res = await fetch(target.uploadUrl, {
                           method: "PUT",
                           headers: { "Content-Type": f.type || "image/png" },
                           body: f,
                         });
                         if (!res.ok) throw new Error(`UPLOAD_${res.status}`);
                         await call("event.branding", { eventId: event.id, brandLogoPath: target.path });
                       }, t.saved);
                     }} />
            </label>
            <button className="primary" type="submit" disabled={busy}
                    style={{ alignSelf: "end" }}>{t.save}</button>
          </form>
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

          <h2>{t.wallLayout}</h2>
          <form
            className="row"
            onSubmit={(ev) => {
              ev.preventDefault();
              void run(
                () => call("event.wallLayout", {
                  slug: event.slug,
                  wallConfig: {
                    ...(event.wall_config ?? {}),
                    led: { columns: ledCols, rows: ledRows, cycleSeconds: ledCycle,
                           brandPattern: ledPattern, cutoutPattern: ledCutouts },
                  },
                }),
                t.saved,
              );
            }}
          >
            <label style={{ margin: 0 }}>
              <span>{t.layoutColumns}</span>
              <input style={{ maxWidth: 90 }} type="number" min={2} max={12} value={ledCols}
                     onChange={(e) => setLedCols(Number(e.target.value))} />
            </label>
            <label style={{ margin: 0 }}>
              <span>{t.layoutRows}</span>
              <input style={{ maxWidth: 90 }} type="number" min={1} max={8} value={ledRows}
                     onChange={(e) => setLedRows(Number(e.target.value))} />
            </label>
            <label style={{ margin: 0 }}>
              <span>{t.layoutCycle}</span>
              <input style={{ maxWidth: 100 }} type="number" min={2} max={120} value={ledCycle}
                     onChange={(e) => setLedCycle(Number(e.target.value))} />
            </label>
            <label style={{ margin: 0 }}>
              <span>{t.layoutBrandPattern}</span>
              <select style={{ maxWidth: 150 }} value={ledPattern}
                      onChange={(e) => setLedPattern(e.target.value)}>
                <option value="none">{t.patternNone}</option>
                <option value="corners">{t.patternCorners}</option>
                <option value="row">{t.patternRow}</option>
              </select>
            </label>
            <label style={{ margin: 0 }}>
              <span>{t.cutoutRow}</span>
              <select style={{ maxWidth: 140 }} value={ledCutouts}
                      onChange={(e) => setLedCutouts(e.target.value)}>
                <option value="none">{t.patternNone}</option>
                <option value="row">{t.patternRow}</option>
              </select>
            </label>
            <button className="primary" type="submit" disabled={busy}
                    style={{ alignSelf: "end" }}>{t.save}</button>
          </form>

          <h2>{t.aiSettings}</h2>
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              void run(
                () => call("event.ai", {
                  slug: event.slug,
                  aiPrompt,
                  aiModel: aiModel || null,
                  budgetUsd: aiBudget === "" ? null : Number(aiBudget),
                  estCostUsd: Number(aiEst) || 0,
                  maxGenerations: aiMax,
                }),
                t.saved,
              );
            }}
            style={{ maxWidth: 640 }}
          >
            <label>
              <span>{t.aiPrompt}</span>
              <textarea rows={3} value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} />
            </label>
            <div className="row">
              <label style={{ margin: 0 }}>
                <span>{t.aiModel}</span>
                <select style={{ maxWidth: 280 }} value={aiModel}
                        onChange={(e) => setAiModel(e.target.value)}>
                  {(event.ai_allowed_models ?? []).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label style={{ margin: 0 }}>
                <span>{t.aiBudget}</span>
                <input style={{ maxWidth: 110 }} type="number" step="0.01" min="0"
                       value={aiBudget} onChange={(e) => setAiBudget(e.target.value)} />
              </label>
              <label style={{ margin: 0 }}>
                <span>{t.aiEstCost}</span>
                <input style={{ maxWidth: 110 }} type="number" step="0.005" min="0"
                       value={aiEst} onChange={(e) => setAiEst(e.target.value)} />
              </label>
              <label style={{ margin: 0 }}>
                <span>{t.aiMaxGenerations}</span>
                <input style={{ maxWidth: 110 }} type="number" min="0"
                       value={aiMax} onChange={(e) => setAiMax(Number(e.target.value))} />
              </label>
              <button className="primary" type="submit" disabled={busy}
                      style={{ alignSelf: "end" }}>{t.save}</button>
            </div>
          </form>

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
