import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Shell } from "../components/Shell";
import { useI18n } from "../i18n";
import { ApiError, call, messageFor } from "../api/client";
import { useSession } from "../state/useSession";

// The control room (feature G). Everything here READS state the database owns and FLIPS
// switches the database enforces — nothing on this screen is the enforcement itself, so a
// control room that dies changes nothing about what the walls and booths will accept.

interface Station {
  device_id: string; kind: string; label: string; queue_depth: number;
  app_version: string | null; seconds_ago: number; online: boolean;
}
interface Summary {
  event: {
    id: string; slug: string; name: string;
    wall_frozen: boolean; panic_brand_only: boolean; intake_paused: boolean;
    ai_paused: boolean; banner_active: boolean;
    banner_text_en: string | null; banner_text_ar: string | null;
    generations_used: number; max_generations: number;
    ai_spend_usd: string; ai_budget_usd: string | null;
  };
  remainingBudget: number;
  failuresLastHour: number;
  telemetry: { rowsThisHour: number; droppedThisHour: number; capPerDeviceHour: number; cappedDevices: number };
  sweepers: { sweeper: string; ran_at: string; changed: number }[];
  jobsByStatus: Record<string, number>;
  photosByBooth: { booth: string; photos: number; approved: number }[];
  recentOps: { service: string; event: string; ok: boolean; n: number; last_seen_at: string; device_id: string }[];
  recentOverrides: { actor_label: string; action: string; target_kind: string; created_at: string }[];
}
interface Health {
  api: boolean; database: boolean; storage: boolean; openrouter: boolean; anam: boolean;
  /** The storage round trip's own verdict, from the newest self-test the deployed function ran
   *  against the real buckets. Optional so an older API deploy degrades to "never proven"
   *  rather than to a confident tick. */
  storageProvenAt?: string | null;
  storageProvenOk?: boolean | null;
  storageProvenAgeSeconds?: number | null;
  sessionHours?: number;
}
interface Cue {
  id: string; position: number; title_en: string; title_ar: string;
  status: string; fired_at: string | null;
}
interface CrewTask {
  id: string; title: string; assignee: string | null; status: string; done_at: string | null;
}

const SWITCHES = [
  { key: "wallFrozen", field: "wall_frozen", label: "wallFrozen" },
  { key: "panicBrandOnly", field: "panic_brand_only", label: "panicBrandOnly" },
  { key: "intakePaused", field: "intake_paused", label: "intakePaused" },
  { key: "aiPaused", field: "ai_paused", label: "aiPaused" },
  { key: "bannerActive", field: "banner_active", label: "bannerActive" },
] as const;

/** A station's age in words a person reads at a glance. "4823s" is a number nobody converts
 *  correctly at one in the morning with a queue building. */
function since(seconds: number): string {
  const n = Math.max(0, Math.round(seconds));
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m`;
  return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
}

export default function Control() {
  const { t } = useI18n();
  const { session } = useSession();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bannerEn, setBannerEn] = useState("");
  const [bannerAr, setBannerAr] = useState("");
  const [cues, setCues] = useState<Cue[]>([]);
  const [tasks, setTasks] = useState<CrewTask[]>([]);
  const [newCueEn, setNewCueEn] = useState("");
  const [newCueAr, setNewCueAr] = useState("");
  const [newTask, setNewTask] = useState("");
  const [newAssignee, setNewAssignee] = useState("");

  const slug = session?.eventSlug ?? "";

  const refresh = useCallback(async () => {
    if (!slug) return;
    try {
      const [sum, st, h, cu, tk] = await Promise.all([
        call<Summary>("ops.summary", { eventSlug: slug }),
        call<Station[]>("ops.stations", {}),
        call<Health>("ops.health", {}),
        call<Cue[]>("cue.list", {}),
        call<CrewTask[]>("task.list", {}),
      ]);
      setSummary(sum);
      setStations(st ?? []);
      setHealth(h);
      setCues(cu ?? []);
      setTasks(tk ?? []);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && !err.isOffline) {
        setError(messageFor(err.code, t as unknown as Record<string, string>));
      }
    }
  }, [slug, t]);

  // Two seconds: the kill-a-station gate says a dead booth is visible within ten, and the
  // per-event threshold is eight — this poll is the last hop of that clock.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    setBannerEn(summary?.event.banner_text_en ?? "");
    setBannerAr(summary?.event.banner_text_ar ?? "");
    // Only seed from the server while the fields are untouched; poll refreshes must not
    // fight the person typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.event.id]);

  /** One shape for every cue/task write: do it, then re-read, so the panel shows the
   *  database's answer rather than an optimistic guess. */
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : "", t as unknown as Record<string, string>));
    } finally {
      setBusy(false);
    }
  }

  async function flip(key: string, value: boolean) {
    setBusy(true);
    try {
      await call("event.switches", { [key]: value });
      await refresh();
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : "", t as unknown as Record<string, string>));
    } finally {
      setBusy(false);
    }
  }

  if (!session) return <Navigate to="/operator/login" replace />;

  const ev = summary?.event;
  const spend = ev ? Number(ev.ai_spend_usd) : 0;
  const budget = ev?.ai_budget_usd != null ? Number(ev.ai_budget_usd) : null;

  return (
    <Shell title={t.controlTitle}>
      <h1>{t.controlTitle}</h1>
      <p className="lede">{slug}</p>
      {error ? <div className="notice bad">{error}</div> : null}

      {ev ? (
        <>
          <div className="row">
            {SWITCHES.map((s) => {
              const on = Boolean((ev as unknown as Record<string, boolean>)[s.field]);
              return (
                <button key={s.key} className={on ? "primary" : ""} disabled={busy}
                        data-switch={s.key} data-on={on}
                        onClick={() => void flip(s.key, !on)}>
                  {t[s.label as keyof typeof t]} {on ? "✓" : ""}
                </button>
              );
            })}
          </div>

          <div className="row" style={{ marginBlockStart: 10 }}>
            <input style={{ maxWidth: 240 }} placeholder={t.bannerTextEn} value={bannerEn}
                   onChange={(e) => setBannerEn(e.target.value)} />
            <input style={{ maxWidth: 240 }} dir="rtl" placeholder={t.bannerTextAr} value={bannerAr}
                   onChange={(e) => setBannerAr(e.target.value)} />
            <button disabled={busy}
                    onClick={() => void flip("bannerTextEn", true).then(() =>
                      call("event.switches", { bannerTextEn: bannerEn, bannerTextAr: bannerAr })
                        .then(() => refresh()))}>
              {t.save}
            </button>
          </div>

          <h2>{t.stations}</h2>
          {stations.length === 0 ? (
            <p className="muted">{t.noStations}</p>
          ) : (
            <table>
              <thead>
                <tr><th>{t.stations}</th><th>{t.booth}</th><th></th><th>{t.stationQueue}</th><th></th></tr>
              </thead>
              <tbody>
                {stations.map((s) => (
                  <tr key={s.device_id} data-station={s.device_id} data-online={s.online}>
                    <td className="muted" style={{ fontFamily: "ui-monospace, monospace", fontSize: ".8rem" }}>
                      {s.device_id.slice(0, 8)}
                    </td>
                    <td>{s.kind}{s.label ? ` · ${s.label}` : ""}</td>
                    <td>
                      <span className={`pill ${s.online ? "ok" : "bad"}`}>
                        {s.online ? t.online : t.offline}
                      </span>
                    </td>
                    <td data-station-depth={s.queue_depth}>
                      {s.queue_depth}
                      {/* A dead station's depth is the last thing it managed to say, not what
                          it is holding now — and "0" is the most dangerous of those, because it
                          reads as "nothing waiting" when the truth is that nobody knows. So an
                          offline row never shows a bare number; it shows when that number was
                          true. */}
                      {!s.online ? (
                        <span className="muted" style={{ fontSize: ".78rem" }} data-station-stale>
                          {" "}· {t.asOf} {since(s.seconds_ago)}
                        </span>
                      ) : null}
                    </td>
                    <td className="muted">{since(s.seconds_ago)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>{t.overview}</h2>
          <div className="grid">
            <div className="card">
              <h3>{t.spendMeter}</h3>
              <p style={{ fontSize: "1.4rem", color: "var(--text)" }}>
                ${spend.toFixed(2)}{budget != null ? ` / $${budget.toFixed(2)}` : ""}
              </p>
              <p>{t.generations}: {ev.generations_used}/{ev.max_generations}</p>
            </div>
            <div className="card">
              <h3>{t.failuresLastHour}</h3>
              <p style={{ fontSize: "1.4rem", color: summary!.failuresLastHour > 0 ? "var(--warn)" : "var(--ok)" }}>
                {summary!.failuresLastHour}
              </p>
              <p>{t.telemetryDropped}: {summary!.telemetry?.droppedThisHour ?? 0}</p>
            </div>
            <div className="card">
              <h3>{t.sweepers}</h3>
              {(summary!.sweepers ?? []).slice(0, 4).map((s) => (
                <p key={s.sweeper} style={{ fontSize: ".82rem" }}>
                  {s.sweeper}: {new Date(s.ran_at).toLocaleTimeString()} · {s.changed}
                </p>
              ))}
            </div>
            <div className="card">
              <h3>{t.configHealth}</h3>
              {health ? (
                <>
                  <p style={{ lineHeight: 2 }}>
                    {(["database", "storage", "openrouter", "anam"] as const).map((k) => {
                      // "storage" used to mean "a URL is configured" — which is true on a
                      // project where not one byte has ever moved through a bucket. Law 8 asks
                      // a surface to say honestly whether it works, not whether it was spelled
                      // correctly, so this pill now carries the round trip's actual verdict.
                      const ok = k === "storage" ? health.storageProvenOk === true : health[k] === true;
                      return (
                        <span key={k} className={`pill ${ok ? "ok" : "warn"}`}
                              style={{ marginInlineEnd: 6 }} data-health={k}>
                          {k} {ok ? "✓" : `· ${t.configMissing}`}
                        </span>
                      );
                    })}
                  </p>
                  <p className="muted" style={{ fontSize: ".8rem", margin: 0 }} data-storage-proof>
                    {health.storageProvenAt
                      ? `${t.storageProven} · ${since(health.storageProvenAgeSeconds ?? 0)}`
                      : t.storageNeverProven}
                  </p>
                </>
              ) : null}
            </div>
          </div>

          <h2>{t.cues}</h2>
          <table>
            <tbody>
              {cues.map((c) => (
                <tr key={c.id} data-cue={c.id} data-cue-status={c.status}>
                  <td className="muted">{c.position}</td>
                  <td>{c.title_en}</td>
                  <td dir="rtl">{c.title_ar}</td>
                  <td className="muted">
                    {c.fired_at ? new Date(c.fired_at).toLocaleTimeString() : ""}
                  </td>
                  <td>
                    <button className={c.status === "done" ? "" : "primary"} disabled={busy}
                            data-fire-cue={c.id}
                            onClick={() => void act(() => call("cue.status", {
                              id: c.id, status: c.status === "done" ? "pending" : "done",
                            }))}>
                      {c.status === "done" ? t.reopenLabel : t.fireCue}
                    </button>
                  </td>
                  <td>
                    <button className="ghost" disabled={busy}
                            onClick={() => void act(() => call("cue.delete", { id: c.id }))}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await call("cue.save", {
                  titleEn: newCueEn, titleAr: newCueAr, position: cues.length + 1,
                });
                setNewCueEn(""); setNewCueAr("");
              });
            }}
          >
            <input style={{ maxWidth: 220 }} placeholder={t.cueTitleEn} value={newCueEn}
                   onChange={(e) => setNewCueEn(e.target.value)} data-new-cue-en required />
            <input style={{ maxWidth: 220 }} dir="rtl" placeholder={t.cueTitleAr} value={newCueAr}
                   onChange={(e) => setNewCueAr(e.target.value)} />
            <button className="primary" type="submit" disabled={busy}>{t.create}</button>
          </form>

          <h2>{t.crewTasks}</h2>
          <table>
            <tbody>
              {tasks.map((k) => (
                <tr key={k.id} data-task={k.id} data-task-status={k.status}>
                  <td>{k.title}</td>
                  <td className="muted">{k.assignee ?? ""}</td>
                  <td className="muted">
                    {k.done_at ? new Date(k.done_at).toLocaleTimeString() : ""}
                  </td>
                  <td>
                    <button className={k.status === "done" ? "" : "primary"} disabled={busy}
                            data-done-task={k.id}
                            onClick={() => void act(() => call("task.status", {
                              id: k.id, status: k.status === "done" ? "open" : "done",
                            }))}>
                      {k.status === "done" ? t.reopenLabel : t.doneLabel}
                    </button>
                  </td>
                  <td>
                    <button className="ghost" disabled={busy}
                            onClick={() => void act(() => call("task.delete", { id: k.id }))}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await call("task.save", { title: newTask, assignee: newAssignee || null });
                setNewTask(""); setNewAssignee("");
              });
            }}
          >
            <input style={{ maxWidth: 260 }} placeholder={t.taskTitleLabel} value={newTask}
                   onChange={(e) => setNewTask(e.target.value)} data-new-task required />
            <input style={{ maxWidth: 160 }} placeholder={t.assigneeLabel} value={newAssignee}
                   onChange={(e) => setNewAssignee(e.target.value)} />
            <button className="primary" type="submit" disabled={busy}>{t.create}</button>
          </form>

          <h2>{t.activity}</h2>
          <table>
            <tbody>
              {(summary!.recentOps ?? []).slice(0, 10).map((o, i) => (
                <tr key={i}>
                  <td><span className={`pill ${o.ok ? "ok" : "bad"}`}>{o.service}</span></td>
                  <td>{o.event}{o.n > 1 ? ` ×${o.n}` : ""}</td>
                  <td className="muted">{o.device_id}</td>
                  <td className="muted">{new Date(o.last_seen_at).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>{t.overrides}</h2>
          <table>
            <tbody>
              {(summary!.recentOverrides ?? []).slice(0, 10).map((o, i) => (
                <tr key={i}>
                  <td>{o.actor_label}</td>
                  <td>{o.action}</td>
                  <td className="muted">{o.target_kind}</td>
                  <td className="muted">{new Date(o.created_at).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="muted">{t.loading}</p>
      )}
    </Shell>
  );
}
