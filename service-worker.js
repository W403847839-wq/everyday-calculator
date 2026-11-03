const APP_URL = "/everyday-calculator/?v=cloudbase";
const APP_ICON = "/everyday-calculator/app-icon-192.png";

const SHELL_CACHE = "calculator-shell-20261103-1";
const SHELL_ROOT = "/everyday-calculator/";
const SHELL_FILES = [APP_URL, SHELL_ROOT + "chat-upgrades.js?v=20261103-1", SHELL_ROOT + "chat-theme.css?v=20261018-4"];
self.addEventListener("install", event => event.waitUntil((async () => {
  try { const cache = await caches.open(SHELL_CACHE); await cache.addAll(SHELL_FILES); } catch {}
  await self.skipWaiting();
})()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith("calculator-shell-") && key !== SHELL_CACHE) await caches.delete(key);
  await self.clients.claim();
})()));

// Only the public calculator shell is cached. API responses, messages and photos
// must never enter the shared offline cache.
self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  const navigation = request.mode === "navigate" && [SHELL_ROOT, SHELL_ROOT + "index.html"].includes(url.pathname);
  const asset = ["chat-upgrades.js", "chat-theme.css"].some(name => url.pathname === SHELL_ROOT + name);
  if (!navigation && !asset) return;
  const network = (async () => {
    const response = await fetch(request);
    if (response.ok && response.type !== "opaque") { const cache = await caches.open(SHELL_CACHE); await cache.put(navigation ? APP_URL : request, response.clone()); }
    return response;
  })();
  event.waitUntil(network.catch(() => {}));
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(navigation ? APP_URL : request);
    if (!navigation && cached) return cached;
    if (!cached) return network;
    let timer;
    try {
      const response = await Promise.race([network.catch(() => null), new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); })]);
      return response?.ok ? response : cached;
    } finally { clearTimeout(timer); }
  })());
});

let badgeWork = Promise.resolve();
function enqueueBadge(work) {
  badgeWork = badgeWork.catch(() => {}).then(work);
  return badgeWork;
}
async function clearReadNotifications() {
  try {
    if (typeof self.navigator.clearAppBadge === "function") await self.navigator.clearAppBadge();
    else if (typeof self.navigator.setAppBadge === "function") await self.navigator.setAppBadge(0);
  } catch {}
  const notifications = await self.registration.getNotifications().catch(() => []);
  notifications.filter(item => ["calculator-update", "notification-check"].includes(item.tag)).forEach(item => item.close());
}
self.addEventListener("message", event => {
  if (event.data?.type !== "CHAT_MESSAGES_READ") return;
  event.waitUntil(enqueueBadge(clearReadNotifications));
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const unreadCount = Math.max(1, Number(data.unreadCount) || 1);
  event.waitUntil(enqueueBadge(async () => {
    if ("setAppBadge" in self.navigator) await self.navigator.setAppBadge(unreadCount).catch(() => {});
    await self.registration.showNotification(data.title || "个人所得税计算器", {
    body: data.body || "计算数据已更新",
    icon: data.icon || APP_ICON,
    badge: APP_ICON,
    tag: "calculator-update",
    renotify: false,
    silent: true,
    data: { url: data.url || APP_URL },
    });
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    windows.forEach(client => client.postMessage({ type: "CHAT_PUSH_RECEIVED" }));
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || APP_URL;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url.includes("/everyday-calculator/"));
    if (existing) {
      await existing.focus();
      return existing.navigate(target);
    }
    return self.clients.openWindow(target);
  })());
});
