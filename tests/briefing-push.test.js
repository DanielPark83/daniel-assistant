import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';
import { buildBriefing, buildMorningPush } from '../js/briefing.js';
import { targets, sendAll, msUntil } from '../tools/send-briefing.mjs';
import { utf8ToBase64, base64ToUtf8, bytesToB64url, b64urlToBytes } from '../js/b64.js';
import { parseConnectPayload, deviceLabel } from '../js/sync.js';

// 기준 시각: 2026-11-18(수) 08:00
const NOW = new Date(2026, 10, 18, 8, 0);
const iso = (h) => new Date(2026, 10, 18, h, 0).toISOString();

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
}

beforeEach(() => { store.init(memoryStorage()); });

test('아침 알림: 오늘 할 일, 미완료, 메모를 요약한다', () => {
  store.addTodo({ title: '분기 보고서 제출', due: '2026-11-18', time: '15:00', priority: 'high' });
  store.addTodo({ title: '팀 회의 안건', due: '2026-11-18' });
  store.addTodo({ title: '견적서 회신', due: '2026-11-16', priority: 'high' });
  store.addTodo({ title: '책 반납', due: '2026-11-17', priority: 'low' });
  store.addEvent({ title: '로드맵 회의', date: '2026-11-18', time: '10:30' });
  store.replaceAll({ ...store.getState(), memos: [
    { id: 'm1', title: '온보딩 아이디어', body: '체크리스트를 3단계로 줄이기', createdAt: iso(7), updatedAt: iso(7) },
    { id: 'm2', title: '장보기', body: '우유', createdAt: iso(6), updatedAt: iso(6) },
  ] });
  // replaceAll은 수정 시각을 지금으로 바꾸므로, 메모 시각을 기준 시각에 맞춘다
  store.getState().memos.forEach((m, i) => { m.updatedAt = iso(7 - i); });

  const p = buildMorningPush(store.getState(), NOW);
  assert.equal(p.title, '11월 18일 수요일 아침 브리핑');
  assert.equal(p.url, './#briefing');
  assert.deepEqual(p.body.split('\n'), [
    '오늘 할 일 2건 · 미완료 2건 · 일정 1건',
    '• 분기 보고서 제출 (오후 3시) · 중요',
    '• 팀 회의 안건',
    '미완료: 견적서 회신(2일 지연) 외 1건',
    '최근 메모: 온보딩 아이디어 — 체크리스트를 3단계로 줄이기 외 1건',
  ]);
});

test('아침 알림: 아무것도 없을 때', () => {
  const p = buildMorningPush(store.getState(), NOW);
  assert.deepEqual(p.body.split('\n'), ['오늘 할 일 0건', '오늘은 예정된 할 일이 없습니다. 좋은 하루 보내세요!']);
});

test('브리핑: 최근 메모가 없으면 고정 메모를 보여 준다', () => {
  store.replaceAll({ memos: [
    { id: 'p', title: '분기 목표', body: '매출 10% 성장', pinned: true },
    { id: 'n', title: '오래된 메모', body: '' },
  ] });
  store.getState().memos.forEach((m) => { m.updatedAt = '2026-11-01T00:00:00.000Z'; });
  const b = buildBriefing(store.getState(), NOW);
  const sec = b.sections.find((x) => x.key === 'memos');
  assert.equal(sec.title, '고정 메모');
  assert.deepEqual(sec.items, ['분기 목표 — 매출 10% 성장']);
  assert.match(b.markdown, /## 고정 메모\n- 분기 목표 — 매출 10% 성장/);
});

test('브리핑: 메모는 5개까지 보여 주고 나머지는 개수로', () => {
  const memos = Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, title: `메모 ${i}`, body: '' }));
  store.replaceAll({ memos });
  store.getState().memos.forEach((m, i) => { m.updatedAt = iso(i); });
  const sec = buildBriefing(store.getState(), NOW).sections.find((x) => x.key === 'memos');
  assert.equal(sec.items.length, 5);
  assert.equal(sec.more, 2);
  assert.equal(sec.items[0], '메모 6');
});

const VAPID = { publicKey: 'B'.repeat(87), privateKey: 'k'.repeat(43), createdAt: iso(1) };
const sub = (n) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } });

test('알림 대상: 현재 알림 키로 구독한 기기만', () => {
  const state = store.normalize({
    vapid: VAPID,
    devices: {
      'd-phone': { label: 'iPhone', push: sub(1), vapidKey: VAPID.publicKey },
      'd-old': { label: '옛 기기', push: sub(2), vapidKey: 'C'.repeat(87) },
      'd-pc': { label: 'Windows PC', push: null },
    },
  });
  assert.deepEqual(targets(state).map((t) => t.label), ['iPhone']);
  assert.deepEqual(targets(store.normalize({ devices: { 'd-xxx': { push: sub(3) } } })), []);
});

test('알림 보내기: 실패와 만료를 구분한다', async () => {
  const state = store.normalize({
    vapid: VAPID,
    devices: {
      'd-aaa': { label: 'A', push: sub('ok'), vapidKey: VAPID.publicKey },
      'd-bbb': { label: 'B', push: sub('gone'), vapidKey: VAPID.publicKey },
    },
  });
  const calls = [];
  const send = async (s, payload, opts) => {
    calls.push({ s, payload: JSON.parse(payload), opts });
    if (s.endpoint.endsWith('gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
    return { statusCode: 201 };
  };
  const { results } = await sendAll(state, { now: NOW, send, subject: 'https://example.com/' });
  assert.deepEqual(results.map((r) => [r.label, r.ok, !!r.expired]), [['A', true, false], ['B', false, true]]);
  assert.equal(calls[0].payload.title, '11월 18일 수요일 아침 브리핑');
  assert.equal(calls[0].opts.vapidDetails.privateKey, VAPID.privateKey);
  assert.equal(calls[0].opts.TTL, 21600);
});

test('8시까지 기다리는 시간 계산', () => {
  assert.equal(msUntil('08:00', new Date(2026, 10, 18, 7, 52)), 8 * 60000);
  assert.equal(msUntil('08:00', new Date(2026, 10, 18, 8, 5)), 0);
  assert.equal(msUntil('08:00', new Date(2026, 10, 18, 6, 0)), 0); // 너무 이르면 기다리지 않는다
  assert.equal(msUntil('', new Date()), 0);
});

test('Base64: 한글과 이모지가 깨지지 않는다', () => {
  const text = '분기 보고서 ⏫ 📅 2026-11-20 — "따옴표"';
  assert.equal(base64ToUtf8(utf8ToBase64(text)), text);
  assert.equal(base64ToUtf8(`${utf8ToBase64(text).slice(0, 10)}\n${utf8ToBase64(text).slice(10)}`), text);
  const bytes = new Uint8Array([0, 251, 255, 62, 63, 1]);
  assert.deepEqual([...b64urlToBytes(bytesToB64url(bytes))], [...bytes]);
  assert.ok(!/[+/=]/.test(bytesToB64url(bytes)));
});

test('연결 링크 해석과 검증', () => {
  const enc = (o) => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
  const good = { v: 1, t: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', o: 'DanielPark83', r: 'my-data', b: 'main' };
  assert.deepEqual(parseConnectPayload(`https://x.github.io/app/#connect=${enc(good)}`),
    { token: good.t, owner: 'DanielPark83', repo: 'my-data', branch: 'main' });
  assert.deepEqual(parseConnectPayload(`connect=${enc(good)}`.replace('connect=', '')), { token: good.t, owner: 'DanielPark83', repo: 'my-data', branch: 'main' });
  assert.equal(parseConnectPayload('https://example.com/'), null);
  assert.equal(parseConnectPayload(`#connect=${enc({ ...good, o: '../evil' })}`), null);
  assert.equal(parseConnectPayload(`#connect=${enc({ ...good, v: 2 })}`), null);
  assert.equal(parseConnectPayload('#connect=!!!notbase64!!!'), null);
});

test('기기 이름 추정', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iPhone');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 15; SM-S928N) Mobile Safari'), 'Android 폰');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Windows PC');
});
