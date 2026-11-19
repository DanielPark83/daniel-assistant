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
  const s = store.getState();
  const me = s.devices[sync.deviceId()];
  return !!(me && me.push) && (!s.vapid || me.vapidKey === s.vapid.publicKey)
    && 'Notification' in window && Notification.permission === 'granted';
}

export function receivingDevices() {
  return Object.entries(store.getState().devices)
    .filter(([, d]) => d.push)
    .map(([id, d]) => ({ id, label: d.label, here: id === sync.deviceId() }));
}

async function registration() {
  if (!('serviceWorker' in navigator)) throw new Error('이 브라우저는 알림을 지원하지 않습니다.');
  return withTimeout(navigator.serviceWorker.ready, 8000,
    () => new PushStepError('등록', '앱의 백그라운드 작업(서비스 워커)이 준비되지 않았습니다. 앱을 완전히 닫았다가 다시 열어 주세요.'));
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

// 단계마다 시간 제한을 둔다. 실패하면 어느 단계에서 왜 멈췄는지 알려 준다.
export class PushStepError extends Error {
  constructor(step, message, cause) {
    super(message);
    this.step = step;
    this.detail = cause ? `${cause.name || 'Error'}: ${cause.message || cause}` : '';
  }
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// 옛 Safari는 콜백 방식이라 둘 다 받는다
function askPermission() {
  return new Promise((resolve, reject) => {
    try {
      const r = Notification.requestPermission(resolve);
      if (r && typeof r.then === 'function') r.then(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

// 사용자 탭에서 바로 호출해야 한다. 권한 요청과 구독은 네트워크를 기다리지 않고 곧바로 한다
// (iPhone은 탭 직후에만 권한을 물을 수 있고, 기다리는 사이 탭의 효력이 사라질 수 있다).
// onStep(이름): 진행 상황 표시용
export async function enable(onStep = () => {}) {
  const reason = unsupportedReason();
  if (reason) throw new Error(reason);
  if (!sync.isConnected()) throw new Error('먼저 기기 간 동기화를 연결해 주세요. 아침 브리핑은 동기화된 데이터로 만들어집니다.');

  // 1) 권한
  onStep('알림 권한 확인 중…');
  let permission = Notification.permission;
  if (permission !== 'granted') {
    try {
      permission = await withTimeout(askPermission(), 60000,
        () => new PushStepError('권한', '알림 권한 창이 1분 동안 응답하지 않았습니다.'));
    } catch (err) {
      throw err instanceof PushStepError ? err : new PushStepError('권한', '알림 권한을 요청하지 못했습니다.', err);
    }
  }
  if (permission === 'denied') {
    throw new PushStepError('권한', '알림이 차단되어 있습니다. 휴대폰 설정 → 알림에서 이 앱(개인 비서)의 알림을 허용한 뒤 다시 눌러 주세요.');
  }
  if (permission !== 'granted') throw new PushStepError('권한', '알림 권한을 허용하지 않았습니다. 다시 눌러 「허용」을 선택해 주세요.');

  // 2) 이 기기를 알림 서버에 등록
  onStep('알림 등록 중…');
  let vapid = store.getState().vapid;
  if (!vapid) vapid = store.setVapid(await generateVapid());
  let pushInfo;
  try {
    pushInfo = await withTimeout(subscribeWith(vapid.publicKey), 25000,
      () => new PushStepError('등록', '휴대폰의 알림 서비스가 25초 동안 응답하지 않았습니다. 앱을 완전히 닫았다가 다시 열어 한 번 더 눌러 주세요.'));
  } catch (err) {
    if (err instanceof PushStepError) throw err;
    throw new PushStepError('등록', '휴대폰의 알림 서비스에 등록하지 못했습니다.', err);
  }
  store.setDevice(sync.deviceId(), { label: sync.deviceLabel(), push: pushInfo, vapidKey: vapid.publicKey });

  // 3) 동기화 저장소에 저장 (실패해도 이 기기에는 남아 있다가 다음 동기화 때 올라간다)
  onStep('저장 중…');
  const saved = await withTimeout(sync.syncNow(), 45000, () => new PushStepError('저장', 'timeout')).catch(() => false);
  if (saved) await withTimeout(reconcile(), 30000, () => new Error('timeout')).catch(() => {});
  return { saved: !!saved };
}

export async function disable() {
  try {
    const reg = await registration();
    const sub = await withTimeout(reg.pushManager.getSubscription(), 10000, () => new Error('timeout'));
    if (sub) await withTimeout(sub.unsubscribe(), 10000, () => new Error('timeout'));
  } catch { /* 구독이 없거나 응답이 없으면 그대로 진행 */ }
  store.setDevice(sync.deviceId(), { label: sync.deviceLabel(), push: null, vapidKey: null });
  await withTimeout(sync.syncNow(), 45000, () => new Error('timeout')).catch(() => {});
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
