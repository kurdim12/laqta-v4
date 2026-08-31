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
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      // Without this, SIGNING an upload URL for an object that already exists is refused —
      // which is the retry path, not an edge case. The outbox re-asks for upload URLs every
      // time it retries a photo, so a shot whose bytes landed but whose register call failed
      // would be refused here forever, on the sign rather than on the PUT. The production
      // self-test found exactly that; overwriting with identical bytes is what idempotency
      // means for this pipeline.
      "x-upsert": "true",
    },
    body: "{}",
  });
  // The status is part of the name: a 502 that says only "failed" cost a full diagnostic round
  // trip the first time this broke, and the outbox needs the status to tell a retryable
  // upstream blip from a permanent refusal.
  if (!res.ok) throw new ApiError(`UPLOAD_URL_${res.status}`, 502);
  const body = await res.json();
  return `${SUPABASE_URL}/storage/v1${body.url}`;
}

/* A signed URL is a JWT carrying its own issued-at, so signing the same object twice yields two
 * different strings - and the query string is part of the HTTP cache key. Every wall poll was
 * therefore handing the browser a brand-new URL for a thumbnail it was already showing, and the
 * browser dutifully re-downloaded all of them, every few seconds, on the venue uplink whose
 * death is ledger item 1. Three wall screens at a five-second poll is the same picture fetched
 * tens of thousands of times an hour.
 *
 * The URL is cached by (bucket, path, lifetime) and the same string handed back while it is
 * comfortably young, so an unchanged cell is byte-identical across polls and the browser stops
 * asking. REUSE is strictly less than TTL by a wide margin: a URL is retired ten minutes before
 * it could expire, so no viewer is ever handed a signature that dies in their hands. */
const URL_TTL_SECONDS = 3600;
const URL_REUSE_SECONDS = 3000;
const URL_EXPIRY_MARGIN_SECONDS = 600;
const URL_CACHE_MAX = 5000;

const urlCache = new Map<string, { url: string; mintedAt: number }>();

/** The reuse window for a given lifetime, always leaving the margin. Exported through
 *  ops.health so the margin is assertable rather than merely intended. */
function reuseWindowMs(expiresIn: number): number {
  return Math.max(0, Math.min(URL_REUSE_SECONDS, expiresIn - URL_EXPIRY_MARGIN_SECONDS)) * 1000;
}

async function signedReadUrl(bucket: string, path: string, expiresIn = URL_TTL_SECONDS): Promise<string> {
  const key = `${bucket}:${path}:${expiresIn}`;
  const now = Date.now();
  const hit = urlCache.get(key);
  if (hit && now - hit.mintedAt < reuseWindowMs(expiresIn)) return hit.url;

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${path}`, {
    method: "POST",
    headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) throw new ApiError("SIGN_URL_FAILED", 502);
  const body = await res.json();
  const url = `${SUPABASE_URL}/storage/v1${body.signedURL}`;

  // Oldest-first eviction: a Map iterates in insertion order, and an entry is only ever
  // inserted when freshly minted, so the front of the map is the stalest thing in it.
  if (urlCache.size >= URL_CACHE_MAX) {
    for (const k of urlCache.keys()) {
      urlCache.delete(k);
      if (urlCache.size <= URL_CACHE_MAX * 0.9) break;
    }
  }
  urlCache.set(key, { url, mintedAt: now });
  return url;
}

/** Removes an object from a bucket. Used only by the storage self-test, which cleans up after
 *  itself; nothing in the product deletes storage objects today (a deleted photo is soft). */
async function storageDelete(bucket: string, path: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: "DELETE",
    headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` },
  });
  return res.ok;
}

/* ------------------------------------------------------------------------- the actions */

type Ctx = { body: Record<string, any>; session: Session | null; clientKey: string; workerToken: string };

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

/** Resolves an event slug to its id, with the service role, inside this one surface. The
 *  public event shape (api_event_public) carries no id on purpose; a guest registering from
 *  their own phone still has to name the event somehow, and the slug is all they hold. */
async function eventIdBySlug(slug: string): Promise<string | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/events?select=id&slug=eq.${encodeURIComponent(slug)}&limit=1`,
    { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
  );
  if (!res.ok) throw new ApiError("DB_ERROR", 500);
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/** The arguments every moderation verb takes: the photo, and exactly one actor. An operator
 *  may only reach their own event and an admin may reach any — but that rule lives in the
 *  database (moderation_scope), not here, so a mistake in this file cannot widen it. */
function moderator(ctx: Ctx): Record<string, unknown> {
  if (!ctx.session) throw new ApiError("NOT_SIGNED_IN", 401);
  const isAdmin = ctx.session.kind === "admin";
  return {
    p_photo_id: ctx.body.photoId,
    p_operator_id: isAdmin ? null : ctx.session.id,
    p_admin_id: isAdmin ? ctx.session.id : null,
  };
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

  /** Law 6 made repairable. Until 0031 the database could rotate a PIN and nothing could ask
   *  it to: no action, no UI. A credential that leaks mid-event has to be replaceable from a
   *  phone, by the owner, in seconds - so this is the one API action whose absence was itself
   *  the vulnerability. The new PIN is never logged; the audit records only who changed it. */
  async "operator.setPin"(ctx) {
    const admin = requireAdmin(ctx);
    await rpc("api_set_operator_pin", {
      p_operator_id: ctx.body.operatorId,
      p_pin: String(ctx.body.pin ?? ""),
      p_admin_id: admin.id,
    });
    return { rotated: true };
  },

  /** Retires or restores an operator account. verify_operator has required active = true
   *  since 0011, so this genuinely revokes rather than merely hiding a row. */
  async "operator.setActive"(ctx) {
    const admin = requireAdmin(ctx);
    return one(await rpc("api_set_operator_active", {
      p_operator_id: ctx.body.operatorId,
      p_active: Boolean(ctx.body.active),
      p_admin_id: admin.id,
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
   *  type structurally cannot name the AI prompt, budgets or spend. The logo is signed here;
   *  a logo that fails to sign costs the wall its logo, never its event. */
  async "event.get"({ body }) {
    const row = one<any>(await rpc("api_event_public", { p_event_slug: body.slug }));
    if (row?.brand_logo_path) {
      row.brand_logo_url = await signedReadUrl(THUMBS, row.brand_logo_path, 3600)
        .catch(() => null);
    }
    return row;
  },

  /** Admin only: the event lifecycle. draft -> live -> archived; the database's trigger
   *  refuses everything else, so this action cannot be talked into going backwards. */
  async "event.status"(ctx) {
    requireAdmin(ctx);
    return one(await rpc("api_update_event", {
      p_slug: ctx.body.slug, p_name: null, p_ai_prompt: null, p_ai_model: null,
      p_max_generations: null, p_status: ctx.body.status, p_wall_config: null,
    }));
  },

  /** Admin only: a signed target for the event's logo. Timestamped path, so replacing a logo
   *  is a new object and every wall's cache moves on with it. */
  async "event.brandingUploadUrl"(ctx) {
    requireAdmin(ctx);
    const eventId = String(ctx.body.eventId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw new ApiError("BAD_EVENT_ID", 400);
    const path = `${eventId}/brand/logo-${Date.now()}.png`;
    return { path, uploadUrl: await signedUploadUrl(THUMBS, path) };
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

  /** Admin only: the shirt picker's catalogue for this event (law 5 — per-event, like every
   *  other setting). An empty list means the surface honestly offers nothing. */
  async "event.shirts"(ctx) {
    requireAdmin(ctx);
    return one(await rpc("api_set_event_shirts", {
      p_event_id: ctx.body.eventId,
      p_shirt_options: ctx.body.shirtOptions ?? [],
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
      // Registration mode: a kiosk that registered its guest binds their shots at capture.
      // The composite foreign key refuses a guest from any other event.
      p_guest_id: ctx.body.guestId ?? null,
      // Picker surfaces (the shirt kiosk) record what the guest chose, at the shutter.
      p_style_choice: ctx.body.styleChoice ?? null,
    }));
  },

  /** One shot, one code (code_per_shot mode). The database refuses this under any other
   *  guest mode, and a retry returns the shot's existing live code rather than a second
   *  one — the operator's button is idempotent the way every capture write is. */
  async "photo.mintCode"(ctx) {
    const isAdmin = ctx.session?.kind === "admin";
    const eventId = isAdmin ? ctx.body.eventId : operatorEvent(ctx).eventId;
    return one(await rpc("api_mint_guest_code", {
      p_event_id: eventId,
      p_photo_id: ctx.body.photoId,
      p_guest_id: null,
      p_issued_by: isAdmin ? null : ctx.session!.id,
      p_ttl_hours: 720,
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
      styleChoice: r.style_choice,
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

  /** Feature E: "admin sees all, overrides anything, every override logged." Until 0032 every
   *  one of these required an operator session and threw 403 for an admin, so the second half
   *  of that sentence was not true of the product. Both actors are accepted now; the database
   *  decides what each may touch (an operator is confined to their own event, an admin is not)
   *  and routes the override to the matching half of the audit trail. */
  async "photo.approve"(ctx) {
    return one(await rpc("approve_photo", moderator(ctx)));
  },

  async "photo.unapprove"(ctx) {
    return one(await rpc("unapprove_photo", moderator(ctx)));
  },

  async "photo.hide"(ctx) {
    return one(await rpc("api_hide_photo", moderator(ctx)));
  },

  async "photo.unhide"(ctx) {
    return one(await rpc("api_unhide_photo", moderator(ctx)));
  },

  async "photo.reject"(ctx) {
    return one(await rpc("api_reject_photo", { ...moderator(ctx), p_reason: ctx.body.reason ?? null }));
  },

  async "photo.delete"(ctx) {
    return one(await rpc("api_delete_photo", { ...moderator(ctx), p_reason: ctx.body.reason ?? null }));
  },

  async "photo.useOriginal"(ctx) {
    return one(await rpc("api_use_original", moderator(ctx)));
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

  /** Registration mode: creates the guest and their gallery code. Works from an armed kiosk
   *  (the operator session names the event) or from the guest's own phone (by event slug).
   *  The database refuses any event whose mode is not 'registration', and consumes a
   *  per-client platform limit BEFORE writing anything — laws 11 and 12 on the write side. */
  async "guest.register"(ctx) {
    let eventId: string | null;
    if (ctx.session?.kind === "operator") {
      eventId = operatorEvent(ctx).eventId;
    } else {
      const slug = String(ctx.body.slug ?? "").trim();
      if (!slug) throw new ApiError("BAD_SLUG", 400);
      eventId = await eventIdBySlug(slug);
      if (!eventId) return { outcome: "not_found" };
    }
    return one(await rpc("api_register_guest", {
      p_event_id: eventId,
      p_display_name: ctx.body.displayName ?? null,
      p_phone: ctx.body.phone ?? null,
      p_email: ctx.body.email ?? null,
      p_locale: ctx.body.locale ?? "ar",
      p_consent: Boolean(ctx.body.consent),
      p_retain_days: 90,
      p_client: ctx.clientKey,
      p_limit: 10,
    }));
  },

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

  /* -------------------------------------------- show cues and crew tasks (feature I, G) */

  async "cue.list"(ctx) {
    const eventId = ctx.session?.kind === "admin" ? ctx.body.eventId : operatorEvent(ctx).eventId;
    return await rpc("api_list_cues", { p_event_id: eventId });
  },

  async "cue.save"(ctx) {
    const eventId = ctx.session?.kind === "admin" ? ctx.body.eventId : operatorEvent(ctx).eventId;
    return one(await rpc("api_save_cue", {
      p_id: ctx.body.id ?? null, p_event_id: eventId,
      p_position: ctx.body.position ?? null,
      p_title_en: ctx.body.titleEn ?? null, p_title_ar: ctx.body.titleAr ?? null,
    }));
  },

  async "cue.status"(ctx) {
    const eventId = ctx.session?.kind === "admin" ? ctx.body.eventId : operatorEvent(ctx).eventId;
    return one(await rpc("api_set_cue_status", {
      p_id: ctx.body.id, p_event_id: eventId, p_status: ctx.body.status,
      p_actor: ctx.session?.username ?? null,
    }));
  },

  async "cue.delete"(ctx) {
    const eventId = ctx.session?.kind === "admin" ? ctx.body.eventId : operatorEvent(ctx).eventId;
    await rpc("api_delete_cue", { p_id: ctx.body.id, p_event_id: eventId });
    return { deleted: true };
  },

  async "task.list"(ctx) {
    const eventId = ctx.session?.kind === "admin" ? ctx.body.eventId : operatorEvent(ctx).eventId;
    return await rpc("api_list_tasks", { p_event_id: eventId });
  },

  async "task.save"(ctx) {
    const eventId = ctx.session?.kind === "admin" ? ctx.body.eventId : operatorEvent(ctx).eventId;
    return one(await rpc("api_save_task", {
      p_id: ctx.body.id ?? null, p_event_id: eventId,
      p_title: ctx.body.title ?? null, p_assignee: ctx.body.assignee ?? null,
    }));
  },

  async "task.status"(ctx) {
    const eventId = ctx.session?.kind === "admin" ? ctx.body.eventId : operatorEvent(ctx).eventId;
    return one(await rpc("api_set_task_status", {
      p_id: ctx.body.id, p_event_id: eventId, p_status: ctx.body.status,
      p_actor: ctx.session?.username ?? null,
    }));
  },

  async "task.delete"(ctx) {
    const eventId = ctx.session?.kind === "admin" ? ctx.body.eventId : operatorEvent(ctx).eventId;
    await rpc("api_delete_task", { p_id: ctx.body.id, p_event_id: eventId });
    return { deleted: true };
  },

  /* ---------------------------------------------------------- the avatar's ladder (I, 8) */

  /** The top rung of the avatar kiosk's degradation ladder. With no key in the project's
   *  secrets this answers its honest name and the kiosk runs its fallback mode; the day the
   *  owner pastes the Anam key into Supabase secrets, this starts answering with a session
   *  token and the live rung lights up — no deploy, no code change (law 8). */
  async "avatar.session"(ctx) {
    operatorEvent(ctx);
    const key = Deno.env.get("ANAM_API_KEY");
    if (!key) return { outcome: "not_configured" };
    const res = await fetch("https://api.anam.ai/v1/auth/session-token", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) return { outcome: "unreachable", status: res.status };
    const body = await res.json().catch(() => null);
    return { outcome: "ok", sessionToken: body?.sessionToken ?? null };
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
   *  reveals a secret's value — only whether it is present. The URL-cache numbers are here so
   *  the margin between "we stop reusing" and "the signature dies" is assertable by a gate
   *  rather than merely intended. */
  async "ops.health"() {
    return {
      api: true,
      database: Boolean(SUPABASE_URL && SERVICE_KEY),
      storage: Boolean(SUPABASE_URL),
      openrouter: Boolean(Deno.env.get("OPENROUTER_API_KEY")),
      anam: Boolean(Deno.env.get("ANAM_API_KEY")),
      urlTtlSeconds: URL_TTL_SECONDS,
      urlReuseSeconds: Math.round(reuseWindowMs(URL_TTL_SECONDS) / 1000),
      urlExpiryMarginSeconds: URL_TTL_SECONDS - Math.round(reuseWindowMs(URL_TTL_SECONDS) / 1000),
      urlCacheEntries: urlCache.size,
    };
  },

  /** The storage round trip, tested by the only process that can: this one. Not one byte had
   *  ever moved through Supabase Storage in this project's history - every photo passes through
   *  a signed upload, a PUT and a signed read that had run zero times in production - and the
   *  build machine cannot reach the project's own domain to try it. So the function tests
   *  itself: it uploads a real PNG, signs a read, fetches it back, compares the bytes, proves
   *  the signed URL is stable across two signings, and deletes what it made.
   *
   *  Authenticated by the worker token rather than a session, so pg_cron and the gate suite can
   *  trigger it with no human credential in existence. It writes its result to sweeper_runs, so
   *  the proof is a row a gate can assert forever rather than a message someone once read. */
  async "ops.selfTest"(ctx) {
    const expected = await rpc<string>("worker_token", { p_name: "selftest" });
    if (ctx.session?.kind !== "admin" && (!expected || ctx.workerToken !== expected)) {
      throw new ApiError("ADMIN_ONLY", 403);
    }

    const started = Date.now();
    // A real 1x1 PNG. The buckets accept jpeg/png/webp by declared type; sending actual PNG
    // bytes means this proves the path a photo takes, not a path that only accepts test data.
    const PNG_1X1 = Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    ), (c) => c.charCodeAt(0));

    const path = `_selftest/${crypto.randomUUID()}.png`;
    const report: Record<string, unknown> = { path, bytes: PNG_1X1.length };

    try {
      const uploadUrl = await signedUploadUrl(THUMBS, path);
      const put = await fetch(uploadUrl, {
        method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG_1X1,
      });
      report.uploadStatus = put.status;
      if (!put.ok) {
        report.uploadBody = (await put.text().catch(() => "")).slice(0, 300);
        throw new ApiError("SELFTEST_UPLOAD_FAILED", 502);
      }

      // Signed twice, deliberately: identical strings are the whole point of the URL cache,
      // and this is the only place that property can be checked against the real signer.
      const first = await signedReadUrl(THUMBS, path);
      const second = await signedReadUrl(THUMBS, path);
      report.urlStable = first === second;

      const got = await fetch(first);
      report.readStatus = got.status;
      const back = new Uint8Array(await got.arrayBuffer());
      report.readBytes = back.length;
      report.bytesMatch = back.length === PNG_1X1.length && back.every((b, i) => b === PNG_1X1[i]);

      // A retried upload of an object that already exists: the shape the outbox must read as
      // success rather than as a permanent failure inside an infinite retry loop.
      const again = await fetch(await signedUploadUrl(THUMBS, path), {
        method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG_1X1,
      });
      report.duplicateStatus = again.status;
      report.duplicateBody = again.ok ? "" : (await again.text().catch(() => "")).slice(0, 200);
    } finally {
      report.deleted = await storageDelete(THUMBS, path);
      report.elapsedMs = Date.now() - started;
      // Recorded whether it passed or failed: a self-test that only leaves a trace when it
      // succeeds is a self-test that hides its own bad news.
      await rpc("record_selftest", { p_detail: report }).catch(() => {});
    }

    return report;
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

    // The same header the AI poke uses. It authenticates callers that are the platform itself
    // rather than a person - today only the storage self-test, which pg_cron and the gate suite
    // can therefore trigger without any human credential existing anywhere.
    const workerToken = req.headers.get("x-laqta-worker") ?? "";

    return json({ ok: true, data: await handler({ body, session, clientKey, workerToken }) });
  } catch (err) {
    const e = err as ApiError;
    const status = e instanceof ApiError ? e.status : 500;
    // The message is a named code from the database or this file. Stack traces and driver
    // detail are deliberately not returned: they are the shape of an information leak.
    return json({ ok: false, error: e.message || "INTERNAL" }, status);
  }
});
