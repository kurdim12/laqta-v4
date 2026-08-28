import { call } from "./client";

// Capture, thumbnailing and upload.
//
// Law 7 begins here. The thumbnail is produced on the device at capture time and uploaded
// alongside the original, so a wall never has to reach for a full-size file. The database
// refuses to let a photo become 'ready' without one, which means this is not a convention the
// client could quietly stop honouring — the row simply would not be publishable.

const THUMB_EDGE = 512;
const THUMB_QUALITY = 0.82;

/** Draws the image into a square, centre-cropped canvas and returns a JPEG blob.
 *  Square because every wall cell is square, so cropping here is what stops the wall from
 *  doing it later at full resolution. */
export async function makeThumbnail(file: Blob, edge = THUMB_EDGE): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    throw new Error("NO_CANVAS");
  }
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, edge, edge);
  bitmap.close?.();

  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", THUMB_QUALITY),
  );
  if (!blob) throw new Error("NO_THUMBNAIL");
  return blob;
}

export interface UploadTarget {
  photoId: string;
  storagePath: string;
  thumbPath: string;
  originalUploadUrl: string;
  thumbUploadUrl: string;
}

async function put(url: string, body: Blob): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": body.type || "image/jpeg" },
    body,
  });
  if (!res.ok) throw new Error(`UPLOAD_FAILED_${res.status}`);
}

export interface CaptureInput {
  photoId: string;
  file: Blob;
  restyle: boolean;
  deviceId: string;
  /** Epoch milliseconds at which the shutter fired on this device. */
  capturedAt: number;
  source: "booth" | "kiosk" | "shirt" | "avatar" | "import";
}

/** The whole journey for one shot: reserve, upload both sizes, register, confirm.
 *
 *  Every step is keyed on a client-minted photo id, so running this twice for the same shot —
 *  which is exactly what a retry after an outage does — converges on one photo rather than
 *  two. That property is what Phase 1's outbox is built on. */
export async function sendCapture(input: CaptureInput): Promise<{ photoId: string }> {
  const target = await call<UploadTarget>("photo.uploadUrl", { photoId: input.photoId });

  const thumb = await makeThumbnail(input.file);
  await put(target.originalUploadUrl, input.file);
  await put(target.thumbUploadUrl, thumb);

  await call("photo.register", {
    photoId: target.photoId,
    storagePath: target.storagePath,
    thumbPath: target.thumbPath,
    bytes: input.file.size,
    kind: "original",
    deviceId: input.deviceId,
    // The moment the shutter actually fired, which after an outage is not the moment this
    // request finally reached the server.
    clientCapturedAt: new Date(input.capturedAt).toISOString(),
    captureSource: input.source,
    // The operator's per-shot decision, recorded by the person who made it. It cannot be
    // recovered later from whether a job row happens to exist.
    restyleIntent: input.restyle ? "restyle" : "straight",
  });
  await call("photo.confirm", { photoId: target.photoId });

  return { photoId: target.photoId };
}

/** A stable per-device identity, so ops can tell one booth tablet from another and the
 *  telemetry cap is charged per device rather than to the event as a whole. */
export function deviceId(): string {
  const KEY = "laqta.device";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "unknown-device";
  }
}
