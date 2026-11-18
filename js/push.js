// 아침 브리핑 알림(Web Push).
// 이 기기의 푸시 구독 정보를 동기화 데이터(devices)에 올려 두면,
// 데이터 저장소의 GitHub Actions가 매일 아침 브리핑을 만들어 각 기기로 보낸다.
// 알림 서명 키(VAPID)는 처음 알림을 켠 기기가 만들어 동기화 데이터에 함께 저장한다.

import * as store from './store.js';
import * as sync from './sync.js';
import { buildMorningPush } from './briefing.js';
import { bytesToB64url, b64urlToBytes } from './b64.js';

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// 이 기기에서 알림을 켤 수 없으면 그 이유를, 켤 수 있으면 빈 문자열을 돌려준다.
export function unsupportedReason() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return '이 브라우저는 알림을 지원하지 않습니다.';
  if (isIOS() && !isStandalone()) {
    return '아이폰·아이패드는 Safari의 「홈 화면에 추가」로 설치한 앱에서만 알림을 켤 수 있습니다(iOS 16.4 이상).';
  }
  if (!('PushManager' in window)) return '이 브라우저는 푸시 알림을 지원하지 않습니다. 최신 Chrome·Edge·Safari를 사용해 주세요.';
  return '';
}

export function isEnabledHere() {
  const me = store.getState().devices[sync.deviceId()];
  return !!(me && me.push) && 'Notification' in window && Notification.permission === 'granted';
}

export function receivingDevices() {
  return Object.entries(store.getState().devices)
    .filter(([, d]) => d.push)
    .map(([id, d]) => ({ id, label: d.label, here: id === sync.deviceId() }));
}

async function registration() {
  if (!('serviceWorker' in navigator)) throw new Error('이 브라우저는 알림을 지원하지 않습니다.');
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('앱을 새로 고친 뒤 다시 시도해 주세요.')), 8000));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

async function generateVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: bytesToB64url(raw), privateKey: jwk.d, createdAt: new Date().toISOString() };
}

const subscriptionKey = (sub) => {
  const k = sub && sub.options && sub.options.applicationServerKey;
  return k ? bytesToB64url(new Uint8Array(k)) : null;
};

async function subscribeWith(vapidKey) {
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (sub && subscriptionKey(sub) !== vapidKey) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(vapidKey) });
  const json = sub.toJSON();
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

// 사용자 탭에서 호출해야 한다(권한 요청 때문에).
export async function enable() {
  const reason = unsupportedReason();
  if (reason) throw new Error(reason);
  if (!sync.isConnected()) throw new Error('먼저 기기 간 동기화를 연결해 주세요. 아침 브리핑은 동기화된 데이터로 만들어집니다.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('알림 권한이 허용되지 않았습니다. 기기 설정에서 이 앱의 알림을 허용해 주세요.');

  // 다른 기기가 이미 만든 알림 키가 있으면 그것을 써야 하므로 먼저 받아 온다.
  if (!(await sync.syncNow()) && sync.getStatus().state === 'error') throw new Error(sync.getStatus().error);
  let vapid = store.getState().vapid;
  if (!vapid) vapid = store.setVapid(await generateVapid());

  const push = await subscribeWith(vapid.publicKey);
  store.setDevice(sync.deviceId(), { label: sync.deviceLabel(), push, vapidKey: vapid.publicKey });
  await sync.syncNow();
  await reconcile(); // 동시에 다른 기기가 먼저 키를 만들었다면 그 키로 다시 구독한다
  if (sync.getStatus().state === 'error') throw new Error(sync.getStatus().error);
}

export async function disable() {
  try {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch { /* 구독이 없으면 그대로 진행 */ }
  store.setDevice(sync.deviceId(), { label: sync.deviceLabel(), push: null, vapidKey: null });
  await sync.syncNow();
}

// 동기화 뒤에 호출: 이 기기의 구독이 현재 알림 키·브라우저 구독과 맞는지 확인하고 고친다.
export async function reconcile() {
  const s = store.getState();
  const me = s.devices[sync.deviceId()];
  if (!me || !me.push || !s.vapid || unsupportedReason()) return;
  if (Notification.permission !== 'granted') return;
  try {
    const reg = await registration();
    const current = await reg.pushManager.getSubscription();
    const keyOk = me.vapidKey === s.vapid.publicKey && subscriptionKey(current) === s.vapid.publicKey;
    if (current && keyOk && current.endpoint === me.push.endpoint) return;
    const push = await subscribeWith(s.vapid.publicKey);
    store.setDevice(sync.deviceId(), { label: sync.deviceLabel(), push, vapidKey: s.vapid.publicKey });
    await sync.syncNow();
  } catch (err) {
    console.warn('알림 구독을 갱신하지 못했습니다.', err);
  }
}

// 지금 데이터로 아침 브리핑 알림을 바로 띄워 본다(이 기기에서만).
export async function testNotification() {
  if (!('Notification' in window)) throw new Error('이 브라우저는 알림을 지원하지 않습니다.');
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('알림 권한이 허용되지 않았습니다.');
  const reg = await registration();
  const p = buildMorningPush(store.getState());
  await reg.showNotification(p.title, {
    body: p.body, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: 'briefing-test', data: { url: p.url },
  });
}
