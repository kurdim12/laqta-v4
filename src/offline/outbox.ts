import { CACHE, OUTBOX, del, get, getAll, put } from "./db";
import { ApiError, call } from "../api/client";
import { makeThumbnail } from "../api/photo";
import { tryCutout } from "../api/cutout";

// LAW 1. "Internet death lost photos and blinded the system → capture is device-first (local
// outbox), sync is background with infinite retry."
//
// The shape that makes this true rather than hopeful:
//
//   THE PHOTO IS SAVED BEFORE ANYTHING IS ATTEMPTED. The shutter writes a record — the image
//   bytes included — into IndexedDB and returns. Nothing about capture depends on a network
//   being there, so a shot taken during an outage is already safe before the first request is
//   ever tried.
//
//   NOTHING IS DELETED UNTIL THE SERVER HAS IT. A record leaves the queue only after the
//   server confirms. That is what makes "the count never drops" true across a restart.
//
//   A CRASH MID-SEND IS NOT A LOST PHOTO AND NOT A DUPLICATE. Records are leased while
//   sending; a lease that outlives the app is reclaimed on the next start and retried. The
//   retry is safe because every write is keyed on the client-minted photo id the record has
//   carried since the shutter fired, and the server refuses to make a second row for it.
//
//   RETRY IS INFINITE. Attempts are counted for display, never to give up. A photo is not
//   discarded because the venue's wifi was bad for an hour.

/** A failure the network will probably fix on its own. Everything else is something a person
 *  may need to know about — a photo the device cannot encode will fail identically forever, and
 *  retrying it silently is how a shot goes missing without anybody noticing. It is still never
 *  discarded; it is surfaced. */
export function isTransient(code: string | undefined): boolean {
  if (!code) return true;
  return code === "OFFLINE"
    || /^UPLOAD_5\d\d$/.test(code)
    // Signing an upload URL is a call to storage like any other: a 5xx there is upstream
    // weather, not a photo this device can never send.
    || /^UPLOAD_URL_5\d\d$/.test(code)
    // A session that expired while the venue was dark is a person's problem, not the photo's.
    // Counting it as a hard failure would flag every queued shot as broken and bury the one
    // message that actually fixes it. The photo is fine; it is waiting for a PIN.
    || code === "NOT_SIGNED_IN"
    || code === "REQUEST_FAILED";
}

/** True when the queue is stalled because nobody is signed in, rather than because the network
 *  is down. The booth shows a different thing for each: one asks for patience, the other asks
 *  for a person. */
export function needsSignIn(items: OutboxItem[]): boolean {
  return items.some((i) => i.state !== "done" && i.lastError === "NOT_SIGNED_IN");
}

const LEASE_MS = 60_000;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000];
const IDLE_POLL_MS = 5000;

export type OutboxState = "pending" | "sending" | "done";

export interface OutboxItem {
  /** The client-minted photo id. Minted at the shutter, used by every later step, and the
   *  reason a retry converges instead of duplicating. */
  id: string;
  eventId: string;
  file: Blob;
  thumb?: Blob;
  restyle: boolean;
  source: "booth" | "kiosk" | "shirt" | "avatar" | "import";
  deviceId: string;
  /** Registration mode: the guest this shot belongs to, decided at the shutter. It rides the
   *  outbox so a registered guest keeps collecting shots straight through an outage. */
  guestId?: string;
  /** What the guest picked at a picker surface (a shirt id). Provenance, like everything
   *  else on this record: written once at the shutter, immune to retries. */
  styleChoice?: string;
  capturedAt: number;
  createdAt: number;
  state: OutboxState;
  attempts: number;
  leasedUntil?: number;
  lastError?: string;
  /** Consecutive failures that the network cannot explain. Never used to give up - only to
   *  decide when to tell the operator that this one needs a human. */
  hardFailures?: number;
}

type Listener = (items: OutboxItem[]) => void;
const listeners = new Set<Listener>();

function notify(items: OutboxItem[]) {
  for (const l of listeners) l(items);
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  void list().then(notify);
  return () => listeners.delete(l);
}

export async function list(): Promise<OutboxItem[]> {
  const items = await getAll<OutboxItem>(OUTBOX);
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

/** How many captures this device is still holding. This is the number ops needs to see. */
export async function depth(): Promise<number> {
  return (await list()).filter((i) => i.state !== "done").length;
}

/** Items failing for a reason the network does not explain, and which a person should look at.
 *  They are still in the queue and still being retried; they are simply no longer silent. */
export function needsAttention(items: OutboxItem[]): OutboxItem[] {
  return items.filter((i) => (i.hardFailures ?? 0) >= 3);
}


/** The bucket's accepted set. Anything else is re-encoded to JPEG before capture completes. */
const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp"]);

async function toAcceptedImage(file: Blob): Promise<Blob> {
  if (ACCEPTED.has(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) { bitmap.close?.(); return file; }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const out: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
    return out ?? file;
  } catch {
    // A device that cannot re-encode still keeps its photo; the upload may fail and be
    // surfaced, which is strictly better than dropping the capture here.
    return file;
  }
}

/** The shutter. Writes the photo to disk and returns; it does not wait for a network. */
export async function enqueue(input: {
  id: string;
  eventId: string;
  file: Blob;
  restyle: boolean;
  source: OutboxItem["source"];
  deviceId: string;
  guestId?: string;
  styleChoice?: string;
}): Promise<void> {
  // Both storage buckets accept jpeg, webp and png only. An iPhone shooting HEIC would be
  // refused by the bucket on every retry, forever, which is a lost photo dressed as patience -
  // so anything outside the accepted set is re-encoded here, at the shutter, before it is ever
  // written to the outbox. Failure to re-encode keeps the original rather than losing the shot.
  const file = await toAcceptedImage(input.file);

  // The thumbnail is produced here, at capture, so an outage cannot leave a photo that can
  // never be published for want of one. Law 7 and law 1 meet at this line.
  let thumb: Blob | undefined;
  try {
    thumb = await makeThumbnail(file);
  } catch {
    // A device that cannot decode its own capture still keeps the original; the thumbnail is
    // retried at send time rather than costing us the photo.
    thumb = undefined;
  }

  const item: OutboxItem = {
    id: input.id,
    eventId: input.eventId,
    file,
    thumb,
    restyle: input.restyle,
    source: input.source,
    deviceId: input.deviceId,
    guestId: input.guestId,
    styleChoice: input.styleChoice,
    capturedAt: Date.now(),
    createdAt: Date.now(),
    state: "pending",
    attempts: 0,
  };
  await put(OUTBOX, item);
  notify(await list());
  void kick();
}

async function putAndNotify(item: OutboxItem) {
  await put(OUTBOX, item);
  notify(await list());
}

/** Enrichment (cutouts today) runs OFF the photo path, one task at a time. Serial because
 *  wasm inference thrashes when parallel; detached because a slow cutout must never stand
 *  between the NEXT photo and the server — law 1 owns the drain loop, decoration does not. */
let enrichment: Promise<void> = Promise.resolve();
function afterThePhotoIsSafe(task: () => Promise<void>) {
  enrichment = enrichment.then(task).catch(() => {
    /* enrichment failing costs nothing the queue can see */
  });
}

async function uploadOne(item: OutboxItem): Promise<void> {
  const target = await call<{
    photoId: string; storagePath: string; thumbPath: string;
    originalUploadUrl: string; thumbUploadUrl: string;
    cutoutPath?: string; cutoutUploadUrl?: string;
  }>("photo.uploadUrl", { photoId: item.id });

  const thumb = item.thumb ?? (await makeThumbnail(item.file));

  const send = async (url: string, body: Blob) => {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": body.type || "image/jpeg" },
      body,
    });
    if (res.ok) return;
    // A storage object that already exists is a retry landing on its own earlier success,
    // which is exactly what idempotency is supposed to look like. Supabase Storage signals
    // that as HTTP 400 with {"statusCode":"409"} in the body, NOT as an HTTP 409 - so the
    // status line alone would turn a successful retry into a permanent failure inside an
    // infinite-retry loop. Both shapes are read as the same thing.
    if (res.status === 409) return;
    const detail = await res.text().catch(() => "");
    if (/"statusCode"\s*:\s*"?409"?|Duplicate|already exists/i.test(detail)) return;
    throw new ApiError(`UPLOAD_${res.status}`, res.status);
  };

  await send(target.originalUploadUrl, item.file);
  await send(target.thumbUploadUrl, thumb);

  await call("photo.register", {
    photoId: item.id,
    storagePath: target.storagePath,
    thumbPath: target.thumbPath,
    bytes: item.file.size,
    kind: "original",
    deviceId: item.deviceId,
    clientCapturedAt: new Date(item.capturedAt).toISOString(),
    captureSource: item.source,
    restyleIntent: item.restyle ? "restyle" : "straight",
    guestId: item.guestId ?? null,
    styleChoice: item.styleChoice ?? null,
  });
  await call("photo.confirm", { photoId: item.id });

  // The photo is safe and publishable from here. Everything below is enrichment: it may
  // fail, time out, or be skipped, and the photo is not diminished — only un-enriched.

  if (item.restyle) {
    // Enqueue is idempotent server-side (a partial unique index converges retries on the
    // existing job), so a crash between confirm and here cannot start a second paid job.
    await call("photo.enqueue", { photoId: item.id }).catch(() => {
      /* AI paused or not configured: the original stands, which is the designed fallback */
    });
  }

  if (target.cutoutUploadUrl && target.cutoutPath) {
    // One bounded attempt (law 2's hard timeout lives inside tryCutout). No retry loop: a
    // photo that cannot be cut out is a photo the wall shows as a thumbnail, silently.
    // Detached: inference takes seconds per photo, and ten photos taken during an outage
    // must not confirm ten inferences apart when the network returns.
    const { cutoutUploadUrl, cutoutPath } = target;
    const file = item.file;
    const photoId = item.id;
    afterThePhotoIsSafe(async () => {
      const cutout = await tryCutout(file);
      if (cutout) {
        await send(cutoutUploadUrl, cutout);
        await call("photo.setCutout", { photoId, cutoutPath });
      }
    });
  }
}

let draining = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Reclaims anything whose lease has lapsed, during normal running. */
async function reclaimStale(): Promise<void> {
  const now = Date.now();
  for (const item of await list()) {
    if (item.state === "sending" && (item.leasedUntil ?? 0) < now) {
      await put(OUTBOX, { ...item, state: "pending", leasedUntil: undefined });
    }
  }
}

/** Reclaims EVERYTHING mid-flight, unconditionally, at start-up.
 *
 *  A page that has just loaded holds no in-flight request, so any record left 'sending' was
 *  abandoned by a process that no longer exists. Waiting out its lease would make a restarted
 *  station look stalled for a minute while it sat on photos it could send immediately. The
 *  retry is safe for the same reason every retry here is safe: the write is keyed on the
 *  client-minted photo id, and the server will not make a second row for it. */
async function reclaimOnStart(): Promise<void> {
  for (const item of await list()) {
    if (item.state === "sending") {
      await put(OUTBOX, { ...item, state: "pending", leasedUntil: undefined });
    }
  }
}

export async function drain(): Promise<{ sent: number; failed: number }> {
  if (draining) return { sent: 0, failed: 0 };
  draining = true;
  let sent = 0;
  let failed = 0;
  try {
    await reclaimStale();
    for (const item of await list()) {
      if (item.state !== "pending") continue;

      await putAndNotify({ ...item, state: "sending", leasedUntil: Date.now() + LEASE_MS });
      try {
        await uploadOne(item);
        // Only now, with the server's confirmation in hand, does the record leave the device.
        await del(OUTBOX, item.id);
        notify(await list());
        sent++;
      } catch (err) {
        failed++;
        const code = err instanceof ApiError ? err.code : String(err);
        // Back to pending. Always. Attempts are counted to show the operator what is
        // happening, never to decide that a photo may be thrown away.
        const hard = isTransient(code) ? 0 : (item.hardFailures ?? 0) + 1;
        await putAndNotify({
          ...item, state: "pending", attempts: item.attempts + 1,
          leasedUntil: undefined, lastError: code, hardFailures: hard,
        });
        // A failure the network cannot explain is reported once it has happened twice, so a
        // photo stuck on a tablet in a venue is visible to whoever is holding the ops screen
        // rather than only to the person standing at that tablet. Fire-and-forget on purpose:
        // law 3 caps and dedupes this server-side, and telemetry may never block the photo
        // path - the report failing must cost nothing, so nothing awaits it.
        if (hard === 2) {
          void call("ops.report", {
            service: "outbox", event: "capture_stuck", ok: false,
            code, error: String(err).slice(0, 200), deviceId: item.deviceId,
          }).catch(() => { /* the queue does not care whether ops heard */ });
        }
        // A network failure means the rest of the queue will fail too; stop and wait rather
        // than burning through every item to no purpose. An expired session is the same shape:
        // every remaining item would fail identically, so the loop stops and the booth asks for
        // a PIN instead of hammering the API with a token it has already refused.
        if (err instanceof ApiError && (err.isOffline || err.code === "NOT_SIGNED_IN")) break;
      }
    }
  } finally {
    draining = false;
  }
  return { sent, failed };
}

function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
}

/** Nudges the drain loop. Safe to call as often as you like. */
export async function kick(): Promise<void> {
  if (timer) clearTimeout(timer);
  const result = await drain();
  const items = await list();
  const pending = items.filter((i) => i.state !== "done");
  const wait = pending.length === 0
    ? IDLE_POLL_MS
    : backoffFor(Math.min(...pending.map((i) => i.attempts)));
  timer = setTimeout(() => void kick(), wait);
  void result;
}

/** Starts background sync for the life of the page. */
export function startSync(): () => void {
  void reclaimOnStart().then(() => kick());
  const onOnline = () => void kick();
  window.addEventListener("online", onOnline);
  const onVisible = () => { if (document.visibilityState === "visible") void kick(); };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    if (timer) clearTimeout(timer);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/* ------------------------------------------------------------------ the wall's local cache */

interface CacheRow<T> { key: string; value: T; savedAt: number }

export async function cacheSet<T>(key: string, value: T): Promise<void> {
  await put<CacheRow<T>>(CACHE, { key, value, savedAt: Date.now() });
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const row = await get<CacheRow<T>>(CACHE, key);
  return row ? row.value : null;
}
