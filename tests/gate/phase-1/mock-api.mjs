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
const cutouts = new Map();         // photoId -> cutoutPath
const enqueues = [];               // photoIds whose restyle was queued
const stations = new Map();        // deviceId -> {kind,label,depth,last}
const placements = new Map();      // cellIndex -> photoId
const switches = { wallFrozen: false, panicBrandOnly: false, intakePaused: false, aiPaused: false, bannerActive: false, bannerTextEn: null, bannerTextAr: null };
const STATION_OFFLINE_MS = 8000;   // mirrors the per-event threshold 0023 defaults to
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
      cutouts: [...cutouts.entries()],
      cutoutUploads: [...uploads.keys()].filter((k) => k.startsWith("/upload/c/")).length,
      enqueues: [...enqueues],
    });
  }
  if (url.pathname === "/__test/outage") {
    failUntil = Date.now() + Number(url.searchParams.get("ms") || 0);
    return json(res, 200, { ok: true, failUntil });
  }
  if (url.pathname === "/__test/reset") {
    photos.clear(); registerCalls.length = 0; uploads.clear(); failUntil = 0;
    cutouts.clear(); enqueues.length = 0; stations.clear(); placements.clear();
    Object.assign(switches, { wallFrozen: false, panicBrandOnly: false, intakePaused: false,
                              aiPaused: false, bannerActive: false, bannerTextEn: null, bannerTextAr: null });
    wall.photoCount = 0; wall.panic = false; wall.frozen = false;
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/__test/wall") {
    if (url.searchParams.has("photos")) wall.photoCount = Number(url.searchParams.get("photos"));
    if (url.searchParams.has("panic")) wall.panic = url.searchParams.get("panic") === "1";
    if (url.searchParams.has("frozen")) wall.frozen = url.searchParams.get("frozen") === "1";
    return json(res, 200, { ok: true, wall });
  }
  if (url.pathname === "/__test/seed") {
    const n = Number(url.searchParams.get("n") || 0);
    const source = url.searchParams.get("source") || "booth";
    for (let i = 0; i < n; i++) {
      const id = `seed-${source}-${i}`;
      photos.set(id, {
        id, status: "ready", approved: false, capture_source: source,
        created_at: new Date(Date.now() - i * 1000).toISOString(),
      });
    }
    return json(res, 200, { ok: true, photos: photos.size });
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
          cutoutPath: `ev-1/${body.photoId}.cutout.png`,
          originalUploadUrl: `http://localhost:${PORT}/upload/o/${body.photoId}`,
          thumbUploadUrl: `http://localhost:${PORT}/upload/t/${body.photoId}`,
          cutoutUploadUrl: `http://localhost:${PORT}/upload/c/${body.photoId}`,
        },
      });

    case "photo.enqueue": {
      enqueues.push(body.photoId);
      return json(res, 200, { ok: true, data: { id: `job-${body.photoId}`, status: "queued" } });
    }

    case "photo.setCutout": {
      cutouts.set(body.photoId, body.cutoutPath);
      return json(res, 200, { ok: true, data: { id: body.photoId, cutout_path: body.cutoutPath } });
    }

    case "ops.report":
      return json(res, 200, { ok: true, data: { recorded: true } });

    case "photo.register": {
      registerCalls.push(body.photoId);
      // The real contract: insert if absent, otherwise change nothing and succeed.
      if (!photos.has(body.photoId)) {
        photos.set(body.photoId, {
          id: body.photoId, status: "processing", approved: false,
          device_id: body.deviceId, restyle_intent: body.restyleIntent,
          capture_source: body.captureSource ?? "booth",
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

    case "station.heartbeat": {
      stations.set(body.deviceId, {
        kind: body.kind ?? "booth", label: body.label ?? "",
        depth: body.queueDepth ?? 0, last: Date.now(),
      });
      return json(res, 200, { ok: true, data: { queue_depth: body.queueDepth } });
    }

    case "ops.stations": {
      const rows = [...stations.entries()].map(([device_id, s]) => ({
        device_id, kind: s.kind, label: s.label, queue_depth: s.depth, app_version: "mock",
        seconds_ago: Math.round((Date.now() - s.last) / 1000),
        online: Date.now() - s.last < STATION_OFFLINE_MS,
      }));
      return json(res, 200, { ok: true, data: rows });
    }

    case "ops.summary":
      return json(res, 200, {
        ok: true,
        data: {
          event: {
            id: "ev-1", slug: body.eventSlug, name: "Mock Event",
            wall_frozen: switches.wallFrozen, panic_brand_only: switches.panicBrandOnly,
            intake_paused: switches.intakePaused, ai_paused: switches.aiPaused,
            banner_active: switches.bannerActive,
            banner_text_en: switches.bannerTextEn, banner_text_ar: switches.bannerTextAr,
            generations_used: 3, max_generations: 1000,
            ai_spend_usd: "0.12", ai_budget_usd: "5.00",
          },
          remainingBudget: 997, failuresLastHour: 0,
          telemetry: { rowsThisHour: 2, droppedThisHour: 0, capPerDeviceHour: 50, cappedDevices: 0 },
          sweepers: [{ sweeper: "sweep_photos", ran_at: new Date().toISOString(), changed: 0 }],
          jobsByStatus: {}, photosByBooth: [],
          recentOps: [], recentOverrides: [],
        },
      });

    case "ops.health":
      return json(res, 200, {
        ok: true,
        data: { api: true, database: true, storage: true, openrouter: false, anam: false },
      });

    case "event.switches": {
      for (const k of ["wallFrozen","panicBrandOnly","intakePaused","aiPaused","bannerActive","bannerTextEn","bannerTextAr"]) {
        if (body[k] !== undefined && body[k] !== null) switches[k] = body[k];
      }
      // the switch state IS the wall state, exactly as it is in the real database
      wall.panic = switches.panicBrandOnly;
      wall.frozen = switches.wallFrozen;
      return json(res, 200, { ok: true, data: { ...switches } });
    }

    case "moderation.feed": {
      const rows = [...photos.values()].map((p) => ({
        id: p.id, kind: "original", status: p.status ?? "ready",
        approved: Boolean(p.approved), createdAt: p.created_at,
        captureSource: p.capture_source ?? "booth", restyleIntent: p.restyle_intent ?? "straight",
        sourcePhotoId: null, operatorBooth: "A", jobStatus: null, jobError: null,
        resultPhotoId: null,
        thumbUrl: `http://localhost:${PORT}/thumb/${p.id}`, cutoutUrl: null,
      }));
      return json(res, 200, { ok: true, data: rows });
    }

    case "photo.approve": {
      const row = photos.get(body.photoId);
      if (row) row.approved = true;
      return json(res, 200, { ok: true, data: row ?? null });
    }

    case "lightbox.place": {
      if (body.photoId == null) placements.delete(body.cellIndex);
      else {
        for (const [cell, pid] of placements) if (pid === body.photoId) placements.delete(cell);
        placements.set(body.cellIndex, body.photoId);
      }
      return json(res, 200, { ok: true, data: { cell_index: body.cellIndex, photo_id: body.photoId } });
    }

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
      // explicit placements override; otherwise the phase-2 synthetic fill applies
      if (placements.size > 0) {
        const cells = [...placements.entries()].map(([cellIndex, pid]) => ({
          cellIndex, photoId: pid, kind: "original",
          thumbUrl: `http://localhost:${PORT}/thumb/${pid}`,
        }));
        return json(res, 200, { ok: true, data: cells });
      }
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
