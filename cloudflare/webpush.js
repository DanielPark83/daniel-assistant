// Web Push 보내기 (Web Crypto만 사용 — Cloudflare Workers, 브라우저, Node 18+에서 동작)
//  - 내용 암호화: RFC 8291 (aes128gcm)
//  - 보내는 쪽 인증: RFC 8292 (VAPID, ES256 JWT)

import { bytesToB64url, b64urlToBytes } from '../js/b64.js';

const te = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  parts.forEach((p) => { out.set(p, o); o += p.length; });
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// 받는 기기의 공개키(p256dh)와 인증값(auth)으로 내용을 암호화한다.
// salt·보내는 쪽 키쌍은 테스트에서만 넘긴다.
export async function encryptPayload(plaintext, p256dh, auth, { salt, senderKeys } = {}) {
  const uaPublic = b64urlToBytes(p256dh);
  const authSecret = b64urlToBytes(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('잘못된 구독 키');

  const keys = senderKeys || await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await subtle().exportKey('raw', keys.publicKey));
  const uaKey = await subtle().importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: uaKey }, keys.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(te.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const s = salt || globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(s, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(s, ikm, te.encode('Content-Encoding: nonce\0'), 12);

  const body = typeof plaintext === 'string' ? te.encode(plaintext) : plaintext;
  const aesKey = await subtle().importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 레코드 하나: 내용 + 0x02(마지막 레코드 구분자)
  const cipher = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, concat(body, new Uint8Array([2]))));

  const header = new Uint8Array(21);
  header.set(s, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

// VAPID 인증 헤더. publicKey: 65바이트 공개키(base64url), privateKey: 32바이트 비밀값(base64url)
export async function vapidAuthorization(endpoint, { subject, publicKey, privateKey }, now = Date.now()) {
  const pub = b64urlToBytes(publicKey);
  if (pub.length !== 65) throw new Error('잘못된 VAPID 공개키');
  const jwk = {
    kty: 'EC', crv: 'P-256', d: privateKey,
    x: bytesToB64url(pub.subarray(1, 33)), y: bytesToB64url(pub.subarray(33, 65)), ext: true,
  };
  const key = await subtle().importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = (o) => bytesToB64url(te.encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject,
  })}`;
  const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned)));
  return `vapid t=${unsigned}.${bytesToB64url(sig)}, k=${publicKey}`;
}

// 알림 하나 보내기. 결과: { ok, status, expired }
export async function sendWebPush(subscription, payload, vapid, { ttl = 3600, urgency = 'high', topic, fetchImpl = fetch } = {}) {
  const body = await encryptPayload(payload, subscription.keys.p256dh, subscription.keys.auth);
  const headers = {
    TTL: String(ttl),
    Urgency: urgency,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: await vapidAuthorization(subscription.endpoint, vapid),
  };
  // Topic은 base64url 문자 32자 이하만 허용된다
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const res = await fetchImpl(subscription.endpoint, { method: 'POST', headers, body });
  return { ok: res.ok, status: res.status, expired: res.status === 404 || res.status === 410 };
}
