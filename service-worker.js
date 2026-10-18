const APP_URL = "/everyday-calculator/?v=cloudbase";
const APP_ICON = "/everyday-calculator/app-icon-192.png";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
