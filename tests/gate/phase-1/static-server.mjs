// Serves the built PWA for the airplane test. SPA fallback so /booth resolves after a reload,
// which the test depends on when it simulates a station being power-cycled mid-event.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("../../../dist/", import.meta.url).pathname;
const PORT = Number(process.env.STATIC_PORT || 8788);
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
  ".json": "application/json", ".png": "image/png",
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let path = join(ROOT, normalize(url.pathname));
  try {
    let body = await readFile(path);
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(ROOT, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  }
}).listen(PORT, () => console.log(`static on ${PORT}`));
