// LAQTA v3 service worker.
//
// Its job is narrow and honest: keep the application shell openable when the venue internet is
// gone, so a station power-cycled mid-event comes back to a working screen instead of a browser
// error page. It deliberately does NOT cache API responses — showing a stale approval queue
// would be worse than showing none.
//
// Two caches, because two kinds of thing live here and they have opposite lifetimes.
//
//   THE SHELL is versioned by its own contents. index.html and the hashed bundles it
//   references change every build, so the cache is named after a digest of that reference list
//   and every older shell is deleted on activate. Before this, one constant name meant every
//   deploy ADDED a megabyte of bundles to a cache nothing ever pruned. That is not merely
//   untidy: a browser under storage pressure evicts a whole origin, and this origin's storage
//   is where the outbox lives. Unbounded cache growth is a slow leak pointed at law 1.
//
//   THE ASSETS are the background-removal model — seventy megabytes of shards whose filenames
//   ARE their content hashes (law 2: the model ships with the app, it is never fetched from
//   someone else's CDN at runtime). Those must survive a deploy untouched. Versioning them with
//   the shell would re-download the whole model on the venue uplink every time a button colour
//   changes, which is the egress failure of law 7 wearing a different hat.
//
// Everything else same-origin is served stale-while-revalidate: the cached copy immediately, a
// refresh in the background. A station is never slower than its cache, and a deploy reaches it
// on the next open instead of never — which is what the single constant cache name meant for
// any asset whose URL does not change (the manifest, the icon, anything added to public/).

const SHELL_PREFIX = "laqta-shell-";
const ASSETS = "laqta-assets";        // content-addressed; never version-pruned
const META = "laqta-meta";
const MODEL_PATH = "/models/";

/* ------------------------------------------------------------------ which shell is live */

let shellName = null;

async function readMeta(key) {
  const cache = await caches.open(META);
  const hit = await cache.match(key);
  return hit ? await hit.text() : null;
}

async function writeMeta(key, value) {
  const cache = await caches.open(META);
  await cache.put(key, new Response(value));
}

async function currentShell() {
  if (shellName) return shellName;
  shellName = await readMeta("/__active_shell");
  return shellName;
}

/* ------------------------------------------------------------------------- installing */

/** The shell's identity is the set of things it references. Same references, same name — so a
 *  rebuild that changes nothing does not churn the cache, and a rebuild that changes a bundle
 *  gets a new one. */
async function shellVersion(refs) {
  const material = new TextEncoder().encode([...refs].sort().join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", material);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The shell is not just index.html: it is index.html AND the hashed bundles it references.
// Caching only the document leaves a station that reloads during an outage staring at a blank
// page while the browser fails to fetch a script. The asset names change every build, so they
// are read out of the document rather than hardcoded or injected by a build step.
async function precacheShell() {
  const refs = new Set();
  let version = "bare";

  try {
    const res = await fetch("./index.html", { cache: "reload" });
    const html = await res.text();
    const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(html))) {
      const url = m[1];
      if (url.startsWith("http") || url.startsWith("//") || url.startsWith("data:")) continue;
      refs.add(new URL(url, self.registration.scope).href);
    }
    version = await shellVersion(refs);
  } catch (_) {
    // A shell that could not be read still installs against whatever is already cached; the
    // alternative is failing installation outright, which is worse.
  }

  const name = SHELL_PREFIX + version;
  const cache = await caches.open(name);
  await cache.addAll(["./", "./index.html", "./manifest.webmanifest"]).catch(() => {});
  await Promise.all([...refs].map((u) => cache.add(u).catch(() => {})));

  // Staged, not promoted. The old shell keeps serving until this one is whole — so a station
  // that installs an update while offline is never left with a half-built cache and no way
  // back. Promotion happens in activate.
  await writeMeta("/__pending_shell", name);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});

/* -------------------------------------------------------------------------- activating */

async function promoteShell() {
  const pending = await readMeta("/__pending_shell");
  const keys = await caches.keys();
  const shells = keys.filter((k) => k.startsWith(SHELL_PREFIX));

  // Promote only a shell that actually exists; otherwise keep whatever is already live rather
  // than pointing at nothing.
  const active = (pending && shells.includes(pending))
    ? pending
    : (await readMeta("/__active_shell")) ?? shells[0] ?? null;

  if (active) {
    await writeMeta("/__active_shell", active);
    shellName = active;
  }

  // Every older shell goes. The asset cache and the meta cache do not: the model is seventy
  // megabytes of content-addressed shards and re-downloading it on a venue uplink because a
  // bundle hash changed would be its own outage.
  await Promise.all(
    shells.filter((k) => k !== active).map((k) => caches.delete(k)),
  );
}

self.addEventListener("activate", (event) => {
  event.waitUntil(promoteShell().then(() => self.clients.claim()).catch(() => self.clients.claim()));
});

/* ----------------------------------------------------------------------------- serving */

/** The model shards. Their names are content hashes, so a hit is correct forever and a miss is
 *  the only reason to touch the network. Never revalidated: re-checking seventy megabytes on
 *  every booth open is exactly the egress this project exists to avoid. */
async function serveAsset(req) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}

/** Everything else on our origin: the cached copy now, a refresh behind it. Never slower than
 *  the cache, and a changed asset at an unchanged URL still reaches the station — on the next
 *  open rather than never, which is what a permanently pinned cache entry meant. */
async function serveShell(req) {
  const name = (await currentShell()) ?? SHELL_PREFIX + "bare";
  const cache = await caches.open(name);
  const hit = await cache.match(req);

  const refresh = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);

  if (hit) {
    // The revalidation runs on its own; the station does not wait for the venue's uplink.
    refresh.catch(() => {});
    return hit;
  }
  return (await refresh) ?? Response.error();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never serve an API or storage response from cache: a wall showing yesterday's photos, or a
  // queue showing decisions already made, is a worse failure than an empty screen.
  if (url.pathname.includes("/functions/v1/") || url.pathname.includes("/storage/v1/")) return;
  if (url.origin !== self.location.origin) return;

  // Navigations fall back to the cached shell so a reload with no network still opens.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async () => {
        const name = (await currentShell()) ?? SHELL_PREFIX + "bare";
        const cache = await caches.open(name);
        return (await cache.match("./index.html")) || Response.error();
      }),
    );
    return;
  }

  event.respondWith(
    url.pathname.includes(MODEL_PATH) ? serveAsset(req) : serveShell(req),
  );
});
