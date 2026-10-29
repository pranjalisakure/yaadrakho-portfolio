const CACHE = "yaadrakho-brand-v4";
const BRAND_ASSETS = ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(BRAND_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (!BRAND_ASSETS.includes(url.pathname)) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch (error) {
      console.error("YaadRakho push payload could not be read", error);
    }
    const reminders = Array.isArray(data.notifications) ? data.notifications : [data];
    for (const reminder of reminders) {
      await self.registration.showNotification(reminder.title || "YaadRakho reminder", {
        body: reminder.body || "You have a customer follow-up today.",
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: reminder.tag || `yaadrakho-reminder-${Date.now()}`,
        renotify: true,
        requireInteraction: true,
        silent: false,
        vibrate: [300, 120, 300],
        timestamp: Date.now(),
        actions: [
          ...(reminder.callUrl ? [{ action: "call", title: "Call" }] : []),
          ...(reminder.whatsappUrl ? [{ action: "whatsapp", title: "WhatsApp" }] : []),
        ],
        data: { url: reminder.url || "/", customerId: reminder.customerId || 0, callUrl: reminder.callUrl || "", whatsappUrl: reminder.whatsappUrl || "" },
      });
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CLOSE_CUSTOMER_REMINDER") return;
  const tag = `yaadrakho-customer-${event.data.customerId}`;
  event.waitUntil(self.registration.getNotifications().then((notifications) => {
    notifications.filter(notification => notification.tag === tag || String(notification.data?.customerId) === String(event.data.customerId)).forEach((notification) => notification.close());
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "call" && event.notification.data?.callUrl) {
    event.waitUntil(self.clients.openWindow(event.notification.data.callUrl));
    return;
  }
  if (event.action === "whatsapp" && event.notification.data?.whatsappUrl) {
    event.waitUntil(self.clients.openWindow(event.notification.data.whatsappUrl));
    return;
  }
  let targetUrl = new URL("/", self.location.origin).href;
  try {
    const candidate = new URL(event.notification.data?.url || "/", self.location.origin);
    if (candidate.origin === self.location.origin) targetUrl = candidate.href;
  } catch {
    // A malformed notification must still open the dashboard.
  }
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin !== self.location.origin || !("focus" in client)) continue;
      try {
        if (client.url === targetUrl) return await client.focus();
        if ("navigate" in client) {
          const navigated = await client.navigate(targetUrl);
          if (navigated) return await navigated.focus();
        }
      } catch {
        // A closing tab may reject navigation; try another tab or open a new one.
      }
    }
    return self.clients.openWindow(targetUrl);
  })());
});
