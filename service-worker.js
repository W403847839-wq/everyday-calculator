const APP_URL = "/everyday-calculator/?v=cloudbase";
const APP_ICON = "/everyday-calculator/app-icon-192.png";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const unreadCount = Math.max(1, Number(data.unreadCount) || 1);
  const badgePromise = "setAppBadge" in self.navigator
    ? self.navigator.setAppBadge(unreadCount).catch(() => {})
    : Promise.resolve();
  const notificationPromise = self.registration.showNotification(data.title || "个人所得税计算器", {
    body: data.body || "计算数据已更新",
    icon: data.icon || APP_ICON,
    badge: APP_ICON,
    tag: "calculator-update",
    renotify: false,
    silent: true,
    data: { url: data.url || APP_URL },
  });
  event.waitUntil(Promise.all([badgePromise, notificationPromise]));
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
