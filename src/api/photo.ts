
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

/* The direct capture path that used to live here — reserve, upload, register, confirm, in one
 * call — is gone, and its absence is the point. Phase 1 replaced it with the outbox, and what
 * was left behind was a SECOND WAY TO TAKE A PHOTO that wrote straight to the network with no
 * queue behind it. Nothing called it. But it was exported, it looked correct, and the first
 * person to reach for "just send this one shot" would have written the venue-internet-dies
 * failure back into the product — law 1 undone by a helper that read like a convenience.
 * Ledger item 9 is about exactly this shape at API scale; it is no better inside one file.
 *
 * Every shot now goes through src/offline/outbox.ts. There is one path, and it survives the
 * network dying because that is the only path there is.
 */

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
