// Minimal service worker: makes the app installable (so Windows can open .dcm
// files with it) and lets it start offline. Network first, cached copy as fallback.
// Scans are never cached – they are opened from local files, not fetched.
//
// It also marks the pages cross-origin isolated (COOP / COEP headers – GitHub Pages cannot send
// them), which lets the automatic segmentation use every CPU core when there is no usable GPU.
// The app only loads files from its own origin, so nothing is blocked by this.
const CACHE = 'qdp-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) =>
  e.waitUntil(
    Promise.all([
      self.clients.claim(),
      // implant library files are kept by the app's own download (src/implantLibrary.ts), not here
      caches
        .open(CACHE)
        .then((c) => c.keys().then((keys) => Promise.all(keys.filter((r) => new URL(r.url).pathname.includes('/implants/')).map((r) => c.delete(r)))))
        .catch(() => {}),
    ]),
  ),
);

function isolated(res) {
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // the AI model and the implant library keep their own caches (downloaded on request): do not
  // store them twice
  if (url.pathname.includes('/models/') || url.pathname.includes('/implants/')) {
    e.respondWith(fetch(req).then(isolated));
    return;
  }
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return isolated(res);
      })
      .catch(() =>
        caches
          // module scripts send an Origin header; the cached copy may have been stored without one
          .match(req, { ignoreVary: true })
          .then((r) => r || caches.match('./'))
          .then(isolated),
      ),
  );
});
