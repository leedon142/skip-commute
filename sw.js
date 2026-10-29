// 앱 화면만 저장해 두고 오프라인일 때 보여줌. 실시간 데이터(/api/)는 항상 네트워크로.
const CACHE = 'skip-shell-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icons/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // 새 배포가 바로 보이도록 네트워크 먼저, 안 되면 저장본
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && e.request.mode === 'navigate') caches.open(CACHE).then((c) => c.put('/', res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request.mode === 'navigate' ? '/' : e.request)),
  );
});

// 웹 푸시: 서버(/api/push, /api/push-send)가 보낸 { title, body, url, tag }를 알림으로 표시
self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data?.json() ?? {}; } catch { msg = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || 'SKIP 통학비서', {
    body: msg.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: msg.tag || 'skip',
    renotify: true,
    data: { url: msg.url || '/?app=1' },
  }));
});

// 알림을 누르면: 열려 있는 앱 창이 있으면 그 창을 앞으로 가져와 해당 화면으로, 없으면 새로 열기
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/?app=1', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      win.postMessage({ type: 'open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
