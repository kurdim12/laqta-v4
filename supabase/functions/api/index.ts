// LAQTA v3 — the API layer.
//
// Law 9: "one API layer. If a workaround ever seems needed, that is an escalation, not a
// second surface." This file is that surface. There is exactly one HTTP entry point, it
// dispatches by an `action` string, and every action is a named function in one table below.
// A second Edge Function, a direct PostgREST call from a browser, or a "quick" bypass route
// would all be the v1 failure repeating, so none of them exists: migration 0008 revoked every
// EXECUTE grant from the anon key, which means the browser physically cannot reach the
// database except through this file.
//
// The service-role key lives only in this process. It is never sent to a client, never logged,
// and never placed in the repository.
//
// verify_jwt is deliberately off: this function performs its own authentication (HMAC-signed
// operator and admin sessions), and the wall and guest surfaces are public by design because
// a wall screen has no operator behind it and guests never log in.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ORIGINALS = "photos";
const THUMBS = "thumbs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ talking to Postgres */

/** Calls one database function. Every database access in the system goes through here. */
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
  if (!res.ok) {
    // Postgres raises named errors (INTAKE_PAUSED, PHOTO_NOT_READY, ...). Those are the
    // contract between the database and this layer, so they are surfaced by name rather than
    // flattened into a generic 500 — the client needs to tell "paused" from "broken".
    let code = "DB_ERROR";
    try {
      const parsed = JSON.parse(text);
      code = String(parsed.message ?? parsed.error ?? code).split("\n")[0].trim() || code;
    } catch (_) { /* keep DB_ERROR */ }
    throw new ApiError(code, 400);
  }
  return text ? JSON.parse(text) : (null as T);
}

/** Postgres set-returning functions come back as arrays; most callers want the first row. */
function one<T>(rows: T[] | null): T | null {
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/* ------------------------------------------------------------------------- sessions
 * Guests never log in (feature B), so only operators and admins hold a session. A session is
 * a signed, expiring statement of who the caller is; it carries no secret of its own, so
 * intercepting one gains an attacker exactly the access that operator already had, until it
 * expires. The signing key is derived from the service-role key, which never leaves this
 * process, so there is no additional secret for the owner to manage.
 */

let signingKey: CryptoKey | null = null;

async function getSigningKey(): Promise<CryptoKey> {
  if (signingKey) return signingKey;
  const material = new TextEncoder().encode(`laqta-v3-session:${SERVICE_KEY}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  signingKey = await crypto.subtle.importKey(
    "raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
  return signingKey;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

interface Session {
  kind: "operator" | "admin";
  id: string;
  eventId?: string;
  role?: string;
  username: string;
  exp: number;
}

async function issueSession(s: Omit<Session, "exp">, hours = 12): Promise<string> {
  const payload: Session = { ...s, exp: Date.now() + hours * 3600000 };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await getSigningKey(), new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

async function readSession(token: string | null): Promise<Session | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC", await getSigningKey(), unb64url(parts[1]), new TextEncoder().encode(parts[0]),
    );
    if (!valid) return null;
    const session = JSON.parse(new TextDecoder().decode(unb64url(parts[0]))) as Session;
    if (session.exp < Date.now()) return null;
    return session;
  } catch (_) {
    return null;
  }
}

/* --------------------------------------------------------------------------- storage
 * Both buckets are private. The browser never holds a bucket credential: it gets a
 * single-use signed URL for exactly one object path, issued here.
 */

async function signedUploadUrl(bucket: string, path: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/${bucket}/${path}`, {
    method: "POST",
    headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new ApiError("UPLOAD_URL_FAILED", 502);
  const body = await res.json();
  return `${SUPABASE_URL}/storage/v1${body.url}`;
}

async function signedReadUrl(bucket: string, path: string, expiresIn = 3600): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${path}`, {
    method: "POST",
    headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) throw new ApiError("SIGN_URL_FAILED", 502);
  const body = await res.json();
  return `${SUPABASE_URL}/storage/v1${body.signedURL}`;
}

/* ------------------------------------------------------------------------- the actions */

type Ctx = { body: Record<string, any>; session: Session | null; clientKey: string };

function requireOperator(ctx: Ctx): Session {
  if (!ctx.session || ctx.session.kind !== "operator") throw new ApiError("NOT_SIGNED_IN", 401);
  return ctx.session;
}

function requireAdmin(ctx: Ctx): Session {
  if (!ctx.session || ctx.session.kind !== "admin") throw new ApiError("ADMIN_ONLY", 403);
  return ctx.session;
}

/** An operator may only ever act inside their own event. The session carries the event, so a
 *  caller cannot name a different one — the composite foreign keys in 0008 are the second
 *  line of this defence, and this is the first. */
function operatorEvent(ctx: Ctx): { operatorId: string; eventId: string } {
  const s = requireOperator(ctx);
  return { operatorId: s.id, eventId: s.eventId! };
}

const actions: Record<string, (ctx: Ctx) => Promise<unknown>> = {
  async ping() {
    return { ok: true, service: "laqta-v3-api" };
  },

  /* ----------------------------------------------------------------------- auth (B) */

  async "admin.login"({ body }) {
    const row = one<any>(await rpc("verify_admin", {
      p_username: String(body.username ?? ""), p_password: String(body.password ?? ""),
    }));
    if (!row || row.outcome !== "ok") {
      return { outcome: row?.outcome ?? "bad_credentials", retryAfter: row?.retry_after ?? null };
    }
    return {
      outcome: "ok",
      token: await issueSession({ kind: "admin", id: row.admin_id, username: row.username }),
      admin: { id: row.admin_id, username: row.username, displayName: row.display_name },
    };
  },

  async "operator.login"({ body, clientKey }) {
    const row = one<any>(await rpc("verify_operator", {
      p_event_slug: String(body.eventSlug ?? ""),
      p_username: String(body.username ?? ""),
      p_pin: String(body.pin ?? ""),
      p_device_id: String(body.deviceId ?? clientKey),
    }));
    if (!row || row.outcome !== "ok") {
      return { outcome: row?.outcome ?? "bad_credentials", retryAfter: row?.retry_after ?? null };
    }
    return {
      outcome: "ok",
      token: await issueSession({
        kind: "operator", id: row.operator_id, eventId: row.event_id,
        role: row.role, username: row.username,
      }),
      operator: {
        id: row.operator_id, eventId: row.event_id, username: row.username,
        displayName: row.display_name, booth: row.booth, role: row.role,
      },
    };
  },

  async "operator.unlock"(ctx) {
    const admin = requireAdmin(ctx);
    return {
      cleared: await rpc("api_unlock_operator", {
        p_event_id: ctx.body.eventId, p_username: ctx.body.username, p_admin_id: admin.id,
      }),
    };
  },

  async "operator.lockState"(ctx) {
    requireAdmin(ctx);
    return one(await rpc("api_operator_lock_state", {
      p_event_id: ctx.body.eventId, p_username: ctx.body.username,
    }));
  },

  /* --------------------------------------------------------------- events and setup (A) */

  async "event.create"(ctx) {
    requireAdmin(ctx);
    return one(await rpc("api_create_event", { p_slug: ctx.body.slug, p_name: ctx.body.name }));
  },

  async "event.list"(ctx) {
    requireAdmin(ctx);
    return await rpc("api_list_events");
  },

  /** Public: what a wall or guest surface may know. Calls api_event_public, whose return
   *  type structurally cannot name the AI prompt, budgets or spend. */
  async "event.get"({ body }) {
    return one(await rpc("api_event_public", { p_event_slug: body.slug }));
  },

  /** Admin only: the LED/lightbox layout, a per-event setting like every other (law 5). */
  async "event.wallLayout"(ctx) {
    requireAdmin(ctx);
    return one(await rpc("api_update_event", {
      p_slug: ctx.body.slug, p_name: null, p_ai_prompt: null, p_ai_model: null,
      p_max_generations: null, p_status: null,
      p_wall_config: ctx.body.wallConfig ?? {},
    }));
  },

  async "event.branding"(ctx) {
    requireAdmin(ctx);
    return one(await rpc("api_set_event_branding", {
      p_event_id: ctx.body.eventId,
      p_name_en: ctx.body.nameEn ?? null,
      p_name_ar: ctx.body.nameAr ?? null,
      p_locale_default: ctx.body.localeDefault ?? null,
      p_locales: ctx.body.locales ?? null,
      p_brand_primary: ctx.body.brandPrimary ?? null,
      p_brand_secondary: ctx.body.brandSecondary ?? null,
      p_brand_logo_path: ctx.body.brandLogoPath ?? null,
      p_brand_wordmark_path: ctx.body.brandWordmarkPath ?? null,
      p_brand_font_family: ctx.body.brandFontFamily ?? null,
      p_guest_mode: ctx.body.guestMode ?? null,
    }));
  },

  /** Admin only: the per-event restyle template, model picker (validated against the allowed
   *  list in the database), caps and reference images (feature D, law 5). */
  async "event.ai"(ctx) {
    requireAdmin(ctx);
    return one(await rpc("api_set_event_ai", {
      p_slug: ctx.body.slug,
      p_ai_prompt: ctx.body.aiPrompt ?? null,
      p_ai_model: ctx.body.aiModel ?? null,
      p_ai_allowed: ctx.body.aiAllowed ?? null,
      p_budget_usd: ctx.body.budgetUsd ?? null,
      p_est_cost_usd: ctx.body.estCostUsd ?? null,
      p_max_generations: ctx.body.maxGenerations ?? null,
      p_reference_paths: ctx.body.referencePaths ?? null,
    }));
  },

  /* -------------------------------------------------------------- control switches (G) */

  async "event.switches"(ctx) {
    // Either an admin or an operator on that event may work the control room.
    const isAdmin = ctx.session?.kind === "admin";
    const eventId = isAdmin ? ctx.body.eventId : operatorEvent(ctx).eventId;
    return one(await rpc("api_set_event_switches", {
      p_event_id: eventId,
      p_wall_frozen: ctx.body.wallFrozen ?? null,
      p_panic_brand_only: ctx.body.panicBrandOnly ?? null,
      p_intake_paused: ctx.body.intakePaused ?? null,
      p_ai_paused: ctx.body.aiPaused ?? null,
      p_banner_active: ctx.body.bannerActive ?? null,
      p_banner_text_en: ctx.body.bannerTextEn ?? null,
      p_banner_text_ar: ctx.body.bannerTextAr ?? null,
      p_operator_id: isAdmin ? null : ctx.session!.id,
      p_admin_id: isAdmin ? ctx.session!.id : null,
    }));
  },

  /* ------------------------------------------------------------------- operators (B) */

  async "operator.create"(ctx) {
    requireAdmin(ctx);
    return one(await rpc("api_create_operator", {
      p_event_id: ctx.body.eventId, p_username: ctx.body.username,
      p_display_name: ctx.body.displayName, p_booth: ctx.body.booth ?? "A",
      p_role: ctx.body.role ?? "operator", p_pin: ctx.body.pin,
    }));
  },

  async "operator.list"(ctx) {
    const eventId = ctx.session?.kind === "admin" ? ctx.body.eventId : operatorEvent(ctx).eventId;
    return await rpc("api_list_operators", { p_event_id: eventId });
  },

  /* ------------------------------------------------------------------- capture (C, 1, 7) */

  /** Hands back two signed URLs: one for the original, one for the thumbnail. Law 7 lives
   *  here — the client is required to produce a thumbnail at upload time, and the database
   *  refuses to let a photo become 'ready' without one, so there is no path by which a wall
   *  ends up serving an 840KB file. */
  async "photo.uploadUrl"(ctx) {
    const { eventId } = operatorEvent(ctx);
    const photoId = String(ctx.body.photoId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(photoId)) throw new ApiError("BAD_PHOTO_ID", 400);
    const base = `${eventId}/${photoId}.jpg`;
    const cutout = `${eventId}/${photoId}.cutout.png`;
    return {
      photoId,
      storagePath: base,
      thumbPath: base,
      cutoutPath: cutout,
      originalUploadUrl: await signedUploadUrl(ORIGINALS, base),
      thumbUploadUrl: await signedUploadUrl(THUMBS, base),
      // The cutout lives in the thumbs bucket: it is wall material, sized for walls, and law 7
      // keeps everything a wall touches inside that bucket.
      cutoutUploadUrl: await signedUploadUrl(THUMBS, cutout),
    };
  },

  /** Idempotent by the client-minted id: this is the write a device's offline outbox retries,
   *  and retrying it can never produce a second photo. */
  async "photo.register"(ctx) {
    const { operatorId, eventId } = operatorEvent(ctx);
    return one(await rpc("api_upsert_photo_if_absent", {
      p_photo_id: ctx.body.photoId, p_event_id: eventId, p_operator_id: operatorId,
      p_kind: ctx.body.kind ?? "original",
      p_storage_path: ctx.body.storagePath, p_thumb_path: ctx.body.thumbPath,
      p_bytes: ctx.body.bytes ?? null,
      p_device_id: ctx.body.deviceId ?? null,
      p_client_captured_at: ctx.body.clientCapturedAt ?? null,
      p_capture_source: ctx.body.captureSource ?? "booth",
      p_restyle_intent: ctx.body.restyleIntent ?? "straight",
    }));
  },

  async "photo.confirm"(ctx) {
    operatorEvent(ctx);
    return one(await rpc("api_confirm_photo", { p_photo_id: ctx.body.photoId }));
  },

  /** Queues the restyle for a captured photo. Idempotent in the database: a partial unique
   *  index converges a replayed enqueue on the existing job, so a retrying outbox cannot
   *  start a second paid generation (laws 1 and 4). */
  async "photo.enqueue"(ctx) {
    const { operatorId, eventId } = operatorEvent(ctx);
    return one(await rpc("api_enqueue_job", {
      p_event_id: eventId, p_photo_id: ctx.body.photoId, p_operator_id: operatorId,
    }));
  },

  /** Records a device-produced cutout. Absence is the designed fallback, never an error. */
  async "photo.setCutout"(ctx) {
    operatorEvent(ctx);
    return one(await rpc("api_set_photo_cutout", {
      p_photo_id: ctx.body.photoId, p_cutout_path: ctx.body.cutoutPath,
    }));
  },

  /** Client telemetry lands in the capped, deduped, per-device store from law 3. A station
   *  reporting its own errors goes through the same arithmetic ceiling as everything else. */
  async "ops.report"(ctx) {
    const { eventId } = operatorEvent(ctx);
    await rpc("record_op", {
      p_service: String(ctx.body.service ?? "station").slice(0, 40),
      p_event: String(ctx.body.event ?? "error").slice(0, 60),
      p_ok: Boolean(ctx.body.ok ?? false),
      p_ms: ctx.body.ms ?? null,
      p_event_id: eventId,
      p_meta: { code: String(ctx.body.code ?? "").slice(0, 60), error: String(ctx.body.error ?? "").slice(0, 200) },
      p_device_id: String(ctx.body.deviceId ?? "unknown").slice(0, 80),
    });
    return { recorded: true };
  },

  async "booth.feed"(ctx) {
    const { operatorId, eventId } = operatorEvent(ctx);
    return await rpc("api_booth_feed", {
      p_event_id: eventId, p_operator_id: operatorId, p_limit: ctx.body.limit ?? 40,
    });
  },

  /** What the queue and war room see: the explicit moderation shape from the database, with
   *  thumbnails and cutouts signed here. Never storage_path — moderation reviews wall
   *  material at wall size (law 7 holds for staff screens too). */
  async "moderation.feed"(ctx) {
    const isAdmin = ctx.session?.kind === "admin";
    const eventId = isAdmin ? ctx.body.eventId : operatorEvent(ctx).eventId;
    const rows = await rpc<any[]>("api_moderation_feed", {
      p_event_id: eventId, p_limit: ctx.body.limit ?? 60,
    });
    return await Promise.all((rows ?? []).map(async (r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      approved: r.approved,
      createdAt: r.created_at,
      captureSource: r.capture_source,
      restyleIntent: r.restyle_intent,
      sourcePhotoId: r.source_photo_id,
      operatorBooth: r.operator_booth,
      jobStatus: r.job_status,
      jobError: r.job_error,
      resultPhotoId: r.result_photo_id,
      thumbUrl: r.thumb_path ? await signedReadUrl(THUMBS, r.thumb_path, 3600) : null,
      cutoutUrl: r.cutout_path ? await signedReadUrl(THUMBS, r.cutout_path, 3600) : null,
    })));
  },

  /* ---------------------------------------------------------------- moderation (E) */

  async "photo.approve"(ctx) {
    const { operatorId } = operatorEvent(ctx);
    return one(await rpc("approve_photo", { p_photo_id: ctx.body.photoId, p_operator_id: operatorId }));
  },

  async "photo.unapprove"(ctx) {
    const { operatorId } = operatorEvent(ctx);
    return one(await rpc("unapprove_photo", { p_photo_id: ctx.body.photoId, p_operator_id: operatorId }));
  },

  async "photo.hide"(ctx) {
    const { operatorId } = operatorEvent(ctx);
    return one(await rpc("api_hide_photo", { p_photo_id: ctx.body.photoId, p_operator_id: operatorId }));
  },

  async "photo.reject"(ctx) {
    const { operatorId } = operatorEvent(ctx);
    return one(await rpc("api_reject_photo", {
      p_photo_id: ctx.body.photoId, p_operator_id: operatorId, p_reason: ctx.body.reason ?? null,
    }));
  },

  async "photo.delete"(ctx) {
    const { operatorId } = operatorEvent(ctx);
    return one(await rpc("api_delete_photo", {
      p_photo_id: ctx.body.photoId, p_operator_id: operatorId, p_reason: ctx.body.reason ?? null,
    }));
  },

  async "photo.useOriginal"(ctx) {
    const { operatorId } = operatorEvent(ctx);
    return one(await rpc("api_use_original", { p_photo_id: ctx.body.photoId, p_operator_id: operatorId }));
  },

  /* ------------------------------------------------------------------- the wall (F, 7)
   * Public: a wall screen has no operator behind it. It returns thumbnails and signed
   * thumbnail URLs only. There is no argument this action accepts that would make it name an
   * original, because the database function it calls does not have that column.
   */

  async "wall.photos"({ body }) {
    const rows = await rpc<any[]>("wall_photos", {
      p_event_slug: body.eventSlug, p_limit: body.limit ?? 24,
    });
    return await Promise.all((rows ?? []).map(async (r) => ({
      id: r.id,
      kind: r.kind,
      createdAt: r.created_at,
      thumbUrl: r.thumb_path ? await signedReadUrl(THUMBS, r.thumb_path, 3600) : null,
      cutoutUrl: r.cutout_path ? await signedReadUrl(THUMBS, r.cutout_path, 3600) : null,
    })));
  },

  /** Public, like wall.photos: one tick of the 28-cell lightbox. The database heals dead
   *  placements, autofills unless frozen, and returns nothing under panic; this layer only
   *  signs the thumbnails. */
  async "wall.lightbox"({ body }) {
    const rows = await rpc<any[]>("wall_lightbox", { p_event_slug: body.eventSlug });
    return await Promise.all((rows ?? []).map(async (r) => ({
      cellIndex: r.cell_index,
      photoId: r.photo_id,
      kind: r.kind,
      thumbUrl: r.thumb_path ? await signedReadUrl(THUMBS, r.thumb_path, 3600) : null,
      cutoutUrl: r.cutout_path ? await signedReadUrl(THUMBS, r.cutout_path, 3600) : null,
    })));
  },

  /** An operator or admin pins a photo to a cell, or clears one. Audited in the database. */
  async "lightbox.place"(ctx) {
    const isAdmin = ctx.session?.kind === "admin";
    const eventId = isAdmin ? ctx.body.eventId : operatorEvent(ctx).eventId;
    return one(await rpc("api_lightbox_place", {
      p_event_id: eventId,
      p_cell_index: ctx.body.cellIndex,
      p_photo_id: ctx.body.photoId ?? null,
      p_operator_id: isAdmin ? null : ctx.session!.id,
      p_admin_id: isAdmin ? ctx.session!.id : null,
    }));
  },

  /* --------------------------------------------------------------------- guests (H, 11) */

  async "guest.lookup"({ body, clientKey }) {
    return one(await rpc("api_guest_lookup", {
      p_code: String(body.code ?? ""), p_client: clientKey, p_limit: 30,
    }));
  },

  async "guest.photos"({ body, clientKey }) {
    // The lookup is charged first, so fetching a gallery cannot be used to sidestep the
    // enumeration limit by skipping straight to the photos.
    const look = one<any>(await rpc("api_guest_lookup", {
      p_code: String(body.code ?? ""), p_client: clientKey, p_limit: 30,
    }));
    if (!look || look.outcome !== "ok") return { outcome: look?.outcome ?? "not_found", photos: [] };

    const rows = await rpc<any[]>("api_guest_photos", { p_code: String(body.code ?? "") });
    return {
      outcome: "ok",
      photos: await Promise.all((rows ?? []).map(async (r) => ({
        id: r.id,
        createdAt: r.created_at,
        thumbUrl: r.thumb_path ? await signedReadUrl(THUMBS, r.thumb_path, 3600) : null,
        // A guest may download the photo they posed for. This is the one place an original is
        // ever signed, and it is signed for one object, for one hour.
        downloadUrl: r.storage_path ? await signedReadUrl(ORIGINALS, r.storage_path, 3600) : null,
      }))),
    };
  },

  /* ----------------------------------------------------------------------- ops (G, 8, 10) */

  async "station.heartbeat"(ctx) {
    const { eventId } = operatorEvent(ctx);
    return one(await rpc("api_station_heartbeat", {
      p_event_id: eventId, p_device_id: ctx.body.deviceId, p_kind: ctx.body.kind ?? "booth",
      p_label: ctx.body.label ?? "", p_queue_depth: ctx.body.queueDepth ?? 0,
      p_app_version: ctx.body.appVersion ?? null,
    }));
  },

  async "ops.stations"(ctx) {
    const eventId = ctx.session?.kind === "admin" ? ctx.body.eventId : operatorEvent(ctx).eventId;
    return await rpc("api_stations", { p_event_id: eventId });
  },

  async "ops.summary"(ctx) {
    if (!ctx.session) throw new ApiError("NOT_SIGNED_IN", 401);
    return await rpc("api_ops_summary", { p_event_slug: ctx.body.eventSlug });
  },

  /** Law 8: a surface must be able to say honestly whether it is configured. Nothing here
   *  reveals a secret's value — only whether it is present. */
  async "ops.health"() {
    return {
      api: true,
      database: Boolean(SUPABASE_URL && SERVICE_KEY),
      storage: Boolean(SUPABASE_URL),
      openrouter: Boolean(Deno.env.get("OPENROUTER_API_KEY")),
      anam: Boolean(Deno.env.get("ANAM_API_KEY")),
    };
  },
};

/* ------------------------------------------------------------------------- the entry point */

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status, headers: { ...CORS, "Content-Type": "application/json" },
    });

  try {
    if (req.method !== "POST") throw new ApiError("USE_POST", 405);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const handler = actions[action];
    if (!handler) throw new ApiError("UNKNOWN_ACTION", 404);

    const auth = req.headers.get("authorization");
    const token = auth ? auth.replace(/^Bearer\s+/i, "") : null;
    const session = await readSession(token);

    // Used as the rate-limit subject for guest lookups. Behind a proxy this is the client's
    // address; law 11's counter is only as good as this key, so it is taken from the platform
    // header rather than from anything the client can set freely.
    const fwd = req.headers.get("x-forwarded-for");
    const clientKey = (fwd ? fwd.split(",")[0].trim() : "") || "unknown";

    return json({ ok: true, data: await handler({ body, session, clientKey }) });
  } catch (err) {
    const e = err as ApiError;
    const status = e instanceof ApiError ? e.status : 500;
    // The message is a named code from the database or this file. Stack traces and driver
    // detail are deliberately not returned: they are the shape of an information leak.
    return json({ ok: false, error: e.message || "INTERNAL" }, status);
  }
});
