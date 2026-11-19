// 알림 발송기(Cloudflare Worker) — Cloudflare처럼 UTC 시계에서 돌린다
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { run, messagesFor } from '../cloudflare/worker.js';
import { encryptPayload, vapidAuthorization } from '../cloudflare/webpush.js';
import { normalize } from '../js/store.js';

const b64u = (b) => Buffer.from(b).toString('base64url');

// 받는 쪽(브라우저) 흉내: node:crypto로 따로 구현한 RFC 8291 복호화
function makeClient() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const decrypt = (body) => {
    const buf = Buffer.from(body);
    const salt = buf.subarray(0, 16);
    const idlen = buf[20];
    const asPublic = buf.subarray(21, 21 + idlen);
    const cipher = buf.subarray(21 + idlen);
    const secret = ecdh.computeSecret(asPublic);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, info, 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(cipher.subarray(cipher.length - 16));
    const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
    assert.equal(plain[plain.length - 1], 2, '마지막 레코드 구분자');
    return plain.subarray(0, plain.length - 1).toString('utf8');
  };
  return { keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) }, decrypt };
}

function makeVapid() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65);
  return { publicKey: b64u(raw), privateKey: jwk.d, createdAt: '2026-11-01T00:00:00.000Z', keyObject: publicKey };
}

test('암호화한 알림을 따로 구현한 복호화로 풀 수 있다', async () => {
  const c = makeClient();
  const body = await encryptPayload('{"title":"한글 제목 ✓"}', c.keys.p256dh, c.keys.auth);
  assert.equal(c.decrypt(body), '{"title":"한글 제목 ✓"}');
});

test('VAPID 서명이 공개키로 검증된다', async () => {
  const v = makeVapid();
  const h = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', { subject: 'https://example.com/', ...v }, Date.UTC(2026, 10, 19));
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  assert.equal(k, v.publicKey);
  const [hd, pl, sig] = jwt.split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${hd}.${pl}`), { key: v.keyObject, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  const payload = JSON.parse(Buffer.from(pl, 'base64url'));
  assert.equal(payload.aud, 'https://fcm.googleapis.com');
  assert.equal(payload.sub, 'https://example.com/');
});

// 한국 시간 2026-11-19 23:00 일정(10분 전 알람) → 22:50 KST = 13:50 UTC
const KST = (d, h, m) => Date.UTC(2026, 10, d, h - 9, m);

function sampleData(vapid, client) {
  return {
    format: 1,
    events: [{ id: 'car', title: '세차', date: '2026-11-19', time: '23:00', repeat: 'weekly', remind: 10, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }],
    todos: [{ id: 't1', title: '보고서', due: '2026-11-20', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }],
    vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey, createdAt: vapid.createdAt },
    devices: { 'd-phone': { label: 'Android 폰', push: { endpoint: 'https://push.example/abc', keys: client.keys }, vapidKey: vapid.publicKey, updatedAt: '2026-11-01T00:00:00.000Z' } },
  };
}

test('알람 시각: 한국 시간 기준 그 1분에만', () => {
  const v = makeVapid();
  const state = normalize(sampleData(v, makeClient()));
  assert.deepEqual(messagesFor(state, KST(19, 22, 49)).map((m) => m.title), []);
  assert.deepEqual(messagesFor(state, KST(19, 22, 50)).map((m) => [m.kind, m.title, m.body]), [['reminder', '일정 · 세차', '10분 후(오후 11시) 시작']]);
  // 앱이 띄우는 알림과 같은 tag라야 하나로 합쳐진다(시계와 무관한 값)
  assert.equal(messagesFor(state, KST(19, 22, 50))[0].tag, 'event:car:2026-11-19:23:00:10');
  assert.deepEqual(messagesFor(state, KST(19, 22, 51)).map((m) => m.title), []);
  assert.equal(messagesFor(state, KST(26, 22, 50)).length, 1, '다음 주 목요일에도');
  // 실행이 몇 초 늦어도 같은 분으로 본다
  assert.equal(messagesFor(state, KST(19, 22, 50) + 15000).length, 1);
});

test('아침 브리핑은 한국 시간 8시 정각에만', () => {
  const state = normalize(sampleData(makeVapid(), makeClient()));
  const at8 = messagesFor(state, KST(20, 8, 0));
  assert.deepEqual(at8.map((m) => [m.kind, m.title]), [['briefing', '11월 20일 금요일 아침 브리핑']]);
  assert.match(at8[0].body, /오늘 할 일 1건/);
  assert.equal(messagesFor(state, KST(20, 8, 1)).length, 0);
  assert.equal(messagesFor(state, KST(20, 8, 0), { briefingTime: 'off' }).length, 0);
});

test('발송기 전체: GitHub에서 읽고, 암호화해 보낸다', async () => {
  const v = makeVapid();
  const client = makeClient();
  const data = sampleData(v, client);
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.startsWith('https://api.github.com/')) {
      assert.equal(opts.headers.Authorization, 'Bearer gh-token');
      assert.ok(opts.headers['User-Agent']);
      return new Response(JSON.stringify(data), { status: 200 });
    }
    return new Response('', { status: 201 });
  };
  const env = { GITHUB_TOKEN: 'gh-token', DATA_REPO: 'me/data', DATA_BRANCH: 'main', TZ_OFFSET_MINUTES: '540', BRIEFING_TIME: '08:00', VAPID_SUBJECT: 'https://example.com/' };
  const r = await run(env, KST(19, 22, 50), fetchImpl);
  assert.equal(r.sent, 1);
  const push = calls.find((c) => c.url === 'https://push.example/abc');
  assert.equal(push.opts.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(push.opts.headers.TTL, '1800');
  const msg = JSON.parse(client.decrypt(push.opts.body));
  assert.deepEqual([msg.title, msg.body, msg.url], ['일정 · 세차', '10분 후(오후 11시) 시작', './#calendar']);
  assert.match(calls[0].url, /repos\/me\/data\/contents\/data\/assistant\.json\?ref=main$/);

  // 보낼 것이 없는 분에는 GitHub만 읽는다
  calls.length = 0;
  assert.deepEqual(await run(env, KST(19, 12, 0), fetchImpl), { sent: 0 });
  assert.equal(calls.length, 1);
  // 설정 전·데이터 없음
  assert.deepEqual(await run({}, KST(19, 12, 0), fetchImpl), { skipped: 'not-configured' });
  assert.deepEqual(await run(env, KST(19, 12, 0), async () => new Response('', { status: 404 })), { skipped: 'no-data' });
});

test('만료된 구독은 표시하고 계속 진행한다', async () => {
  const v = makeVapid();
  const client = makeClient();
  const data = sampleData(v, client);
  data.devices['d-old'] = { label: '옛 폰', push: { endpoint: 'https://push.example/gone', keys: makeClient().keys }, vapidKey: v.publicKey };
  const fetchImpl = async (url) => (url.startsWith('https://api.github.com/')
    ? new Response(JSON.stringify(data)) : new Response('', { status: url.endsWith('gone') ? 410 : 201 }));
  const r = await run({ GITHUB_TOKEN: 'x', DATA_REPO: 'me/data' }, KST(19, 22, 50), fetchImpl);
  assert.deepEqual(r.results.map((x) => [x.device, x.ok, x.expired]), [['Android 폰', true, false], ['옛 폰', false, true]]);
});
