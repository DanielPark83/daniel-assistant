// 서비스 워커: 앱 파일을 캐시해 오프라인에서도 열리게 한다.
// 온라인일 때는 항상 최신 파일을 받아 캐시를 갱신한다(네트워크 우선).

const CACHE = 'daniel-assistant-v3';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/store.js',
  'js/nlp.js',
  'js/dates.js',
  'js/briefing.js',
  'js/markdown.js',
  'js/sync.js',
  'js/push.js',
  'js/qr.js',
  'js/b64.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/badge-96.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // 같은 출처의 GET 요청만 다룬다
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))),
  );
});

// ───────── 아침 브리핑 알림 ─────────

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || "Daniel's 개인 비서";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '오늘의 브리핑을 확인해 보세요.',
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    tag: data.tag || 'briefing',
    renotify: true,
    data: { url: data.url || './#briefing' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((c) => c.url.startsWith(self.registration.scope));
    if (open) {
      await open.focus();
      open.postMessage({ type: 'open', hash: target.hash || '#home' });
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
