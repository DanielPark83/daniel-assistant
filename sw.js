// 서비스 워커: 앱 파일을 캐시해 오프라인에서도 열리게 한다.
// 온라인일 때는 매번 서버에 최신 파일인지 확인하고(no-cache) 받아 캐시를 갱신한다.
// 브라우저의 HTTP 캐시(GitHub Pages는 최대 10분)를 거치지 않으므로 새 버전이 바로 반영되고,
// 새 파일과 옛 파일이 섞여 불러와지는 일이 없다.

const CACHE = 'daniel-assistant-v4';
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
  'js/reminders.js',
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
  const url = new URL(req.url);
  // 같은 출처의 GET 요청만 다룬다
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok && !url.pathname.endsWith('/version.json')) {
          // 스크립트는 ?v=버전 주소로 불리지만, 오프라인용 사본은 버전 없이 파일마다 하나만 둔다
          const key = req.mode === 'navigate' ? req : new Request(`${url.origin}${url.pathname}`);
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(key, copy));
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
