// Background removal, on the capture device, against law 2.
//
// v1's version fetched an 80MB model at runtime from a third-party CDN with no timeout, and
// when the venue internet flinched it hung the pipeline forever. Three decisions here make
// that failure structurally impossible:
//
//   THE MODEL SHIPS WITH THE APP. publicPath points at ./models/ on our own origin — the
//   files are in the deploy folder the owner drags to his host. There is no third-party CDN
//   in the path, and after the first load the service worker holds the chunks, so even our
//   own origin is only needed once.
//
//   THE TIMEOUT IS HARD. The whole attempt races a fixed clock. When the clock wins, the
//   attempt is abandoned — not retried, not waited on.
//
//   THE FALLBACK IS AUTOMATIC AND SILENT. A photo without a cutout is a photo the wall shows
//   as a normal thumbnail. Nobody is asked anything; nothing is blocked; the capture pipeline
//   (law 1) never waits on this.

const TIMEOUT_COLD_MS = 90_000;  // the model is not loaded yet: weights + wasm + first graph
const TIMEOUT_WARM_MS = 20_000;  // the model is resident: this is pure inference

let modelLoaded = false;
let unavailable = false;

function modelsBase(): string {
  return new URL("models/", document.baseURI).href;
}

async function loadLibrary() {
  // Dynamically imported so stations that never cut out (walls, admin, guest) never pay for
  // the library. The import itself is part of the timed attempt.
  const mod = await import("@imgly/background-removal");
  return mod.removeBackground;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const clock = setTimeout(() => reject(new Error("CUTOUT_TIMEOUT")), ms);
    work.then(
      (v) => { clearTimeout(clock); resolve(v); },
      (e) => { clearTimeout(clock); reject(e); },
    );
  });
}

/** A one-pixel capture, used to force a REAL model load during warm-up. Importing the
 *  library is milliseconds; reading 44MB of weights and building the graph is the cost that
 *  must not land on the first guest's shot — so the warm-up runs an actual inference. */
async function tinyProbeImage(): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#888";
    ctx.fillRect(0, 0, 8, 8);
  }
  const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("NO_CANVAS");
  return blob;
}

/** Warms the model right after sign-in, so the first real shot is not the one paying the
 *  model-load cost. This is a real inference, not an import: "warm" means the weights are
 *  resident. Failure marks cutouts unavailable for the session — decided honestly, once,
 *  rather than a long timeout on every shot (law 8's degrade-honestly, client-side). */
export async function warmCutout(): Promise<boolean> {
  if (modelLoaded) return true;
  if (unavailable) return false;
  try {
    const probe = await fetch(new URL("resources.json", modelsBase()).href, { method: "HEAD" });
    if (!probe.ok) throw new Error("MODELS_NOT_SHIPPED");
    const removeBackground = await withTimeout(loadLibrary(), 20_000);
    await withTimeout(
      removeBackground(await tinyProbeImage(), {
        publicPath: modelsBase(),
        model: "small",
        output: { format: "image/png", quality: 0.8 },
      }),
      TIMEOUT_COLD_MS,
    );
    modelLoaded = true;
    return true;
  } catch {
    unavailable = true;
    return false;
  }
}

/** One attempt at a cutout, bounded by the hard clock. Null means "use the original" — the
 *  automatic fallback, never an error the pipeline has to handle. */
export async function tryCutout(file: Blob): Promise<Blob | null> {
  if (unavailable) return null;
  try {
    const removeBackground = await withTimeout(loadLibrary(), 20_000);
    const result = await withTimeout(
      removeBackground(file, {
        publicPath: modelsBase(),
        model: "small",
        output: { format: "image/png", quality: 0.9 },
      }),
      modelLoaded ? TIMEOUT_WARM_MS : TIMEOUT_COLD_MS,
    );
    modelLoaded = true;
    return result;
  } catch {
    // Timeout, decode failure, missing chunk — all the same answer: the original is used.
    return null;
  }
}
