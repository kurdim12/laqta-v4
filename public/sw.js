// LAQTA v3 service worker.
//
// Phase 0's job here is narrow and honest: keep the application shell openable when the venue
// internet is gone, so a station that is power-cycled mid-event comes back to a working screen
// instead of a browser error page. It deliberately does NOT cache API responses — showing a
// stale approval queue would be worse than showing none.
//
// Phase 1 adds the outbox that makes law 1 true. This file is the ground it stands on.

const SHELL = "laqta-shell-v1";

// The shell is not just index.html: it is index.html AND the hashed bundles it references.
// Caching only the document leaves a station that reloads during an outage staring at a blank
// page while the browser fails to fetch a script. The asset names change every build, so they
// are read out of the document rather than hardcoded or injected by a build step.
async function precacheShell() {
  const cache = await caches.open(SHELL);
  await cache.addAll(["./", "./index.html", "./manifest.webmanifest"]);

  try {
    const res = await fetch("./index.html", { cache: "reload" });
    const html = await res.text();
    const refs = new Set();
    const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(html))) {
      const url = m[1];
      if (url.startsWith("http") || url.startsWith("//") || url.startsWith("data:")) continue;
      refs.add(new URL(url, self.registration.scope).href);
    }
    await Promise.all([...refs].map((u) => cache.add(u).catch(() => {})));
  } catch (_) {
    // A shell that could not be fully precached still opens; it just may need the network for
    // an asset. Failing installation outright would be worse.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never serve an API or storage response from cache: a wall showing yesterday's photos, or a
  // queue showing decisions already made, is a worse failure than an empty screen.
  if (url.pathname.includes("/functions/v1/") || url.pathname.includes("/storage/v1/")) return;

  // Navigations fall back to the cached shell so a reload with no network still opens.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("./index.html").then((r) => r || Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit || Response.error());
    }),
  );
});
