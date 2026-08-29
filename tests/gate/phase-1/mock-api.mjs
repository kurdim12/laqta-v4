// A stand-in for the API layer, for the airplane test only.
//
// Why a stand-in exists at all: this build session's network policy blocks the project's own
// domain, so the browser under test cannot reach the real Edge Function. What is being tested
// here is the DEVICE half of law 1 — that a photo survives an outage, a restart and a retry,
// and arrives exactly once. The SERVER half (that a repeated write cannot produce a second
// photo) is proved separately and against the real database, by run_all_gates().
//
// So this mock implements the same contract the real API does, and nothing more forgiving:
// registering a photo id that already exists is accepted and changes nothing. If the outbox
// were to send a photo twice, this server would still hold one row — exactly as Postgres does
// via `on conflict (id) do nothing` — and the test asserts on the number of REQUESTS as well,
// so a duplicate send is caught even though a duplicate row is impossible.

import { createServer } from "node:http";

const photos = new Map();          // photoId -> row
const registerCalls = [];          // every register attempt, including duplicates
const uploads = new Map();         // path -> bytes
let failUntil = 0;                 // simulated server-side outage

// Wall-under-test state, mutated via /__test/wall. The mock mirrors the real semantics the
// walls are built against: panic returns nothing, freeze only stops NEW content, and the
// lightbox is a persistent placement keyed by cell index.
import { readFileSync } from "node:fs";
const FIXTURE = readFileSync(new URL("./fixture.png", import.meta.url));
const wall = {
  photoCount: 0,
  panic: false,
  frozen: false,
  config: { led: { columns: 2, rows: 2, cycleSeconds: 2, brandPattern: "none" } },
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, PUT, GET, OPTIONS",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") return json(res, 200, { ok: true });

  // Test-control surface, not part of the product.
  if (url.pathname === "/__test/state") {
    return json(res, 200, {
      photos: [...photos.values()],
      photoCount: photos.size,
      registerCalls: registerCalls.length,
      confirmed: [...photos.values()].filter((p) => p.status === "ready").length,
      uploads: uploads.size,
    });
  }
  if (url.pathname === "/__test/outage") {
    failUntil = Date.now() + Number(url.searchParams.get("ms") || 0);
    return json(res, 200, { ok: true, failUntil });
  }
  if (url.pathname === "/__test/reset") {
    photos.clear(); registerCalls.length = 0; uploads.clear(); failUntil = 0;
    wall.photoCount = 0; wall.panic = false; wall.frozen = false;
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/__test/wall") {
    if (url.searchParams.has("photos")) wall.photoCount = Number(url.searchParams.get("photos"));
    if (url.searchParams.has("panic")) wall.panic = url.searchParams.get("panic") === "1";
    if (url.searchParams.has("frozen")) wall.frozen = url.searchParams.get("frozen") === "1";
    return json(res, 200, { ok: true, wall });
  }
  if (url.pathname.startsWith("/thumb/")) {
    res.writeHead(200, { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" });
    return res.end(FIXTURE);
  }

  // Signed upload targets.
  if (url.pathname.startsWith("/upload/")) {
    if (Date.now() < failUntil) { res.writeHead(503); return res.end("outage"); }
    const body = await readBody(req);
    uploads.set(url.pathname, body.length);
    res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
    return res.end("ok");
  }

  if (url.pathname !== "/api") return json(res, 404, { ok: false, error: "UNKNOWN" });

  if (Date.now() < failUntil) { res.writeHead(503); return res.end("outage"); }

  const body = JSON.parse((await readBody(req)).toString() || "{}");
  const action = body.action;

  switch (action) {
    case "ping":
      return json(res, 200, { ok: true, data: { ok: true } });

    case "operator.login":
      return json(res, 200, {
        ok: true,
        data: {
          outcome: "ok",
          token: "test-token",
          operator: {
            id: "op-1", eventId: "ev-1", username: body.username,
            displayName: "Test Operator", booth: "A", role: "operator",
          },
        },
      });

    case "photo.uploadUrl":
      return json(res, 200, {
        ok: true,
        data: {
          photoId: body.photoId,
          storagePath: `ev-1/${body.photoId}.jpg`,
          thumbPath: `ev-1/${body.photoId}.jpg`,
          originalUploadUrl: `http://localhost:${PORT}/upload/o/${body.photoId}`,
          thumbUploadUrl: `http://localhost:${PORT}/upload/t/${body.photoId}`,
        },
      });

    case "photo.register": {
      registerCalls.push(body.photoId);
      // The real contract: insert if absent, otherwise change nothing and succeed.
      if (!photos.has(body.photoId)) {
        photos.set(body.photoId, {
          id: body.photoId, status: "processing", approved: false,
          device_id: body.deviceId, restyle_intent: body.restyleIntent,
          client_captured_at: body.clientCapturedAt,
          created_at: new Date().toISOString(),
        });
      }
      return json(res, 200, { ok: true, data: photos.get(body.photoId) });
    }

    case "photo.confirm": {
      const row = photos.get(body.photoId);
      if (row) row.status = "ready";
      return json(res, 200, { ok: true, data: row ?? null });
    }

    case "booth.feed":
      return json(res, 200, { ok: true, data: [...photos.values()] });

    case "station.heartbeat":
      return json(res, 200, { ok: true, data: { queue_depth: body.queueDepth } });

    case "event.get":
      return json(res, 200, {
        ok: true,
        data: {
          slug: body.slug, name: "Mock Event", name_ar: "\u062a\u062c\u0631\u0628\u0629", name_en: "Mock Event",
          status: "live", locale_default: "ar", locales: ["ar", "en"],
          brand_primary: "#e8c07a", brand_secondary: "#111111", brand_font_family: null,
          wall_frozen: wall.frozen, panic_brand_only: wall.panic,
          banner_active: false, banner_text_en: null, banner_text_ar: null,
          guest_mode: "wall_only", wall_config: wall.config,
        },
      });

    case "wall.photos": {
      if (wall.panic) return json(res, 200, { ok: true, data: [] });
      const rows = Array.from({ length: wall.photoCount }, (_, i) => ({
        id: `wp-${i}`, kind: "original",
        createdAt: new Date(Date.now() - i * 1000).toISOString(),
        thumbUrl: `http://localhost:${PORT}/thumb/${i}`,
      }));
      return json(res, 200, { ok: true, data: rows });
    }

    case "wall.lightbox": {
      if (wall.panic) return json(res, 200, { ok: true, data: [] });
      const cells = Array.from({ length: Math.min(wall.photoCount, 28) }, (_, i) => ({
        cellIndex: i, photoId: `wp-${i}`, kind: "original",
        thumbUrl: `http://localhost:${PORT}/thumb/${i}`,
      }));
      return json(res, 200, { ok: true, data: cells });
    }

    default:
      return json(res, 404, { ok: false, error: "UNKNOWN_ACTION" });
  }
});

const PORT = Number(process.env.MOCK_PORT || 8787);
server.listen(PORT, () => console.log(`mock-api on ${PORT}`));
