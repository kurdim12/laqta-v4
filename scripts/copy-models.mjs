// Copies the background-removal model into the app's own static assets.
//
// Law 2: v1's background removal fetched an 80MB model at runtime from a third-party CDN with
// no timeout, and hung forever when the venue internet flinched. The library's default
// publicPath is still that CDN, so this script exists to make the third-party fetch
// impossible: the model files ship with the app, from the same origin as the app, and the
// booth points the library at ./models/.
//
// Only what a booth actually uses is shipped: the small model and the three CPU wasm
// runtimes. Every file is a ~4MB content-addressed chunk, comfortably under static hosts'
// per-file limits. Run via `npm run models:copy`; `npm run build` runs it automatically.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDist = join(root, "node_modules/@imgly/background-removal-data/dist");
const outDir = join(root, "public/models");

const WANTED = [
  "/models/small",
  "/onnxruntime-web/ort-wasm.wasm",
  "/onnxruntime-web/ort-wasm-simd.wasm",
  "/onnxruntime-web/ort-wasm-simd-threaded.wasm",
];

if (!existsSync(join(dataDist, "resources.json"))) {
  console.log("models:copy — data package not installed; skipping (the booth will run in cutout fallback)");
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(join(dataDist, "resources.json"), "utf8"));
mkdirSync(outDir, { recursive: true });

const filtered = {};
let files = 0;
let bytes = 0;
for (const key of WANTED) {
  const entry = manifest[key];
  if (!entry) {
    console.error(`models:copy — manifest is missing ${key}`);
    process.exit(1);
  }
  filtered[key] = entry;
  for (const chunk of entry.chunks) {
    const src = join(dataDist, chunk.hash);
    const dst = join(outDir, chunk.hash);
    copyFileSync(src, dst);
    files++;
    bytes += chunk.offsets[1] - chunk.offsets[0];
  }
}
writeFileSync(join(outDir, "resources.json"), JSON.stringify(filtered));
console.log(`models:copy — ${files} chunks, ${(bytes / 1e6).toFixed(1)} MB into public/models/`);
