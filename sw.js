// Service worker: sieć w pierwszej kolejności dla strony, API nigdy nie jest cache'owane.
const CACHE = "ekstraklasa-v14";
const ROOT = new URL("./", self.location).pathname; // "/" na Render, "/sportapi-app/" na GitHub Pages
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll([ROOT, ROOT + "icon.svg"])).catch(() => {})); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.includes("/api/")) return;
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)).catch(() => {}); return r; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match(ROOT))));
});
// powiadomienia push: serwer wysyła zaszyfrowany JSON {title, body, url, tag}
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.title || "Ekstraklasa", { body: d.body || "", tag: d.tag, icon: ROOT + "icon-192.png", badge: ROOT + "icon-192.png", data: { url: d.url || "" } }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(ROOT + (e.notification.data?.url || ""), self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    const c = cs.find((x) => x.url.startsWith(self.location.origin + ROOT));
    if (c) return c.navigate(target).then((x) => (x || c).focus()).catch(() => c.focus());
    return self.clients.openWindow(target);
  }));
});
