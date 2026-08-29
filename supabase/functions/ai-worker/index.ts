// LAQTA v3 — the AI job runner.
//
// Law 4: "generation runs as queued jobs on infrastructure with no forced timeout; job runner
// owns its own clock." v1 died because the platform killed AI work at ~20 seconds while the
// chosen model needs ~90. The shape here is built against that failure:
//
//   THE POKE IS NOT THE CLOCK. pg_cron pokes this function every minute with a five-second
//   HTTP timeout. The function answers immediately and keeps draining through
//   EdgeRuntime.waitUntil, so the poke's timeout bounds the poke, never the generation.
//
//   THE LEASE IS THE CLOCK. A claimed job carries the per-event lease from migration 0014.
//   While a model works, this runner heartbeats the lease; its own abort fires just inside the
//   lease, so a hung upstream is cut off by OUR configured clock — not the platform's, and
//   never in a way that lets the sweeper hand the job to a second worker while the first
//   might still be paying for it.
//
//   MONEY MOVES BEFORE THE CALL AND SETTLES AFTER. consume_generation books the estimate
//   before anything is spent (both the count cap and the dollar cap, atomically). Success
//   settles the estimate against the real cost; every failure refunds it. An event can end
//   under budget having refused work; it cannot end over budget having done it.
//
//   NOT CONFIGURED IS AN HONEST STATE, NOT AN ERROR LOOP (law 8). With no provider key the
//   job fails terminally as AI_NOT_CONFIGURED, the reservation is refunded, and the operator
//   approves the original — the guest never sees any of it.
//
// This function is poked, never called by users. It authenticates the poke against a token
// that lives only in the database, readable only with the service key this process holds.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";

const ORIGINALS = "photos";
const THUMBS = "thumbs";
const MAX_JOBS_PER_POKE = 4;
const HEARTBEAT_MS = 30_000;

const WORKER_ID = `edge-${crypto.randomUUID().slice(0, 8)}`;

/* ----------------------------------------------------------------- database access */

async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RPC ${fn}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : (null as T);
}

function one<T>(rows: T[] | null): T | null {
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function tableInsert(table: string, row: Record<string, unknown>): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(row),
  }).catch(() => { /* worker telemetry must never break the worker */ });
}

/* --------------------------------------------------------------------- storage */

async function signedReadUrl(bucket: string, path: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${path}`, {
    method: "POST",
    headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 600 }),
  });
  if (!res.ok) throw new Error("SIGN_FAILED");
  const body = await res.json();
  return `${SUPABASE_URL}/storage/v1${body.signedURL}`;
}

async function storageUpload(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: bytes as unknown as BodyInit,
  });
  if (!res.ok) throw new Error(`UPLOAD_${res.status}`);
}

/* ------------------------------------------------------------------- generation */

interface Job {
  id: string; event_id: string; photo_id: string; operator_id: string;
  attempts: number;
}
interface EventRow {
  id: string; slug: string; ai_prompt: string; ai_model: string;
  ai_est_cost_usd: string; ai_lease_seconds: number; ai_reference_paths: string[];
}
interface PhotoRow { id: string; storage_path: string }

/** Calls the model with the runner's own clock: heartbeats renew the lease, and the abort
 *  fires just inside it, so upstream can be slow but never unbounded. */
async function generate(
  ev: EventRow, sourceUrl: string, refUrls: string[], job: Job,
): Promise<{ bytes: Uint8Array; cost: number; model: string }> {
  const controller = new AbortController();
  const budgetMs = Math.max(45_000, (ev.ai_lease_seconds - 30) * 1000);
  const killer = setTimeout(() => controller.abort("LEASE_BUDGET"), budgetMs);
  const beat = setInterval(() => {
    void rpc("api_job_heartbeat", { p_job_id: job.id, p_worker: WORKER_ID }).catch(() => {});
  }, HEARTBEAT_MS);

  try {
    const content: unknown[] = [
      { type: "text", text: ev.ai_prompt || "Restyle this event photo." },
      { type: "image_url", image_url: { url: sourceUrl } },
      ...refUrls.map((u) => ({ type: "image_url", image_url: { url: u } })),
    ];
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ev.ai_model,
        messages: [{ role: "user", content }],
        modalities: ["image", "text"],
        usage: { include: true },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OPENROUTER_${res.status}:${text.slice(0, 160)}`);
    }
    const body = await res.json();
    const image = body?.choices?.[0]?.message?.images?.[0]?.image_url?.url as string | undefined;
    if (!image || !image.startsWith("data:")) throw new Error("NO_IMAGE_IN_RESPONSE");

    const b64 = image.slice(image.indexOf(",") + 1);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const cost = Number(body?.usage?.cost ?? 0) || 0;
    return { bytes, cost, model: String(body?.model ?? ev.ai_model) };
  } finally {
    clearTimeout(killer);
    clearInterval(beat);
  }
}

async function processOneJob(eventId: string): Promise<boolean> {
  const job = one<Job>(await rpc("claim_ai_job", { p_event_id: eventId, p_worker: WORKER_ID }));
  if (!job) return false;

  const ev = one<EventRow>(await rpc("api_event_by_id", { p_event_id: eventId }));
  if (!ev) {
    await rpc("api_job_failed", { p_job_id: job.id, p_error: "UNKNOWN_EVENT", p_model: null });
    return true;
  }
  const est = Number(ev.ai_est_cost_usd) || 0;
  const started = Date.now();

  // The cap is consumed BEFORE anything is spent. A refusal is terminal for this job — the
  // gate's "cap blocks the N+1th job before spend" — and burns no money and no retry loop.
  const allowed = await rpc<boolean>("consume_generation", {
    p_event_id: eventId, p_estimated_cost_usd: est,
  });
  if (!allowed) {
    await rpc("api_job_failed", { p_job_id: job.id, p_error: "CAP_REACHED", p_model: ev.ai_model });
    await rpc("record_op", {
      p_service: "ai", p_event: "cap_blocked", p_ok: false, p_ms: null,
      p_event_id: eventId, p_meta: { jobId: job.id }, p_device_id: WORKER_ID,
    });
    return true;
  }

  try {
    if (!OPENROUTER_KEY) {
      // Law 8: run honestly unconfigured. Refund the reservation, fail terminally, and let the
      // moderation queue publish the original. The guest never sees this word.
      await rpc("settle_generation", { p_event_id: eventId, p_estimated_cost_usd: est, p_actual_cost_usd: 0 });
      await rpc("api_job_failed", { p_job_id: job.id, p_error: "AI_NOT_CONFIGURED", p_model: null });
      return true;
    }

    const photo = one<PhotoRow>(await rpc("api_photo", { p_photo_id: job.photo_id }));
    if (!photo) throw new Error("SOURCE_PHOTO_MISSING");

    const sourceUrl = await signedReadUrl(ORIGINALS, photo.storage_path);
    const refUrls: string[] = [];
    for (const p of ev.ai_reference_paths ?? []) {
      try { refUrls.push(await signedReadUrl(ORIGINALS, p)); } catch { /* a missing reference is not fatal */ }
    }

    const out = await generate(ev, sourceUrl, refUrls, job);

    const resultId = crypto.randomUUID();
    const base = `${eventId}/${resultId}.jpg`;
    // A generated image is already display-sized, so the same bytes serve as their own
    // thumbnail for now; a resize pass is queued in the log as debt, not forgotten.
    await storageUpload(ORIGINALS, base, out.bytes, "image/png");
    await storageUpload(THUMBS, base, out.bytes, "image/png");

    await rpc("api_insert_generated_photo", {
      p_photo_id: resultId, p_event_id: eventId, p_operator_id: job.operator_id,
      p_source_photo_id: job.photo_id, p_storage_path: base, p_thumb_path: base,
      p_bytes: out.bytes.length,
    });
    await rpc("api_confirm_photo", { p_photo_id: resultId });
    await rpc("api_job_succeeded", {
      p_job_id: job.id, p_result_photo_id: resultId, p_model: out.model,
      p_latency_ms: Date.now() - started, p_cost_usd: out.cost || est,
    });
    await rpc("settle_generation", {
      p_event_id: eventId, p_estimated_cost_usd: est, p_actual_cost_usd: out.cost || est,
    });
    return true;
  } catch (err) {
    const message = String((err as Error).message ?? err).slice(0, 200);
    // Every failure refunds the reservation: the meter reads money spent, not money hoped.
    await rpc("settle_generation", { p_event_id: eventId, p_estimated_cost_usd: est, p_actual_cost_usd: 0 })
      .catch(() => {});
    // Transient failures requeue under the attempts ceiling; the sweeper turns exhaustion
    // into a terminal failure. "Failure ⇒ branded original" happens in the queue: the
    // operator approves the original and the guest never sees an error.
    await rpc("api_job_requeue", { p_job_id: job.id, p_error: message }).catch(() => {});
    await rpc("record_op", {
      p_service: "ai", p_event: "generation_failed", p_ok: false,
      p_ms: Date.now() - started, p_event_id: eventId,
      p_meta: { code: message.split(":")[0], error: message }, p_device_id: WORKER_ID,
    }).catch(() => {});
    return true;
  }
}

async function drain(): Promise<void> {
  let budget = MAX_JOBS_PER_POKE;
  const events = await rpc<{ event_id: string; queued: number }[]>("api_events_with_queued_jobs");
  for (const e of events ?? []) {
    while (budget > 0) {
      const did = await processOneJob(e.event_id);
      if (!did) break;
      budget--;
    }
    if (budget <= 0) break;
  }
}

/* --------------------------------------------------------------------- entry point */

Deno.serve(async (req) => {
  const token = req.headers.get("x-laqta-worker") ?? "";
  const stored = await fetch(
    `${SUPABASE_URL}/rest/v1/worker_tokens?name=eq.ai-worker&select=token`,
    { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
  ).then((r) => r.json()).then((rows) => rows?.[0]?.token ?? null).catch(() => null);

  if (!stored || token !== stored) {
    return new Response(JSON.stringify({ ok: false, error: "NOT_A_WORKER_POKE" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  const body = await req.json().catch(() => ({}));

  if (body.mode === "probe") {
    // The recorded proof that this infrastructure does not kill at ~20 seconds: hold the
    // clock for the requested time, then write what actually elapsed where ops can read it.
    const seconds = Math.min(180, Math.max(1, Number(body.delaySeconds) || 95));
    const work = (async () => {
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, seconds * 1000));
      await tableInsert("sweeper_runs", {
        sweeper: "ai_worker_probe", changed: seconds,
        detail: { requestedSeconds: seconds, elapsedMs: Date.now() - t0, worker: WORKER_ID },
      });
    })();
    // @ts-ignore EdgeRuntime is provided by the Supabase runtime
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
    else await work;
    return new Response(JSON.stringify({ ok: true, probing: seconds }), {
      status: 202, headers: { "Content-Type": "application/json" },
    });
  }

  // The poke answers now; the drain continues on the runner's own clock.
  const work = drain().catch((err) =>
    tableInsert("sweeper_runs", {
      sweeper: "ai_worker_error", changed: 0,
      detail: { error: String((err as Error).message ?? err).slice(0, 300) },
    }),
  );
  // @ts-ignore EdgeRuntime is provided by the Supabase runtime
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  else await work;

  return new Response(JSON.stringify({ ok: true, worker: WORKER_ID }), {
    status: 202, headers: { "Content-Type": "application/json" },
  });
});
