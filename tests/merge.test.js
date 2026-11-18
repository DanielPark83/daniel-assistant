import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
}

const T = (h) => `2026-11-18T0${h}:00:00.000Z`;
const todo = (id, title, updatedAt, extra = {}) => ({ id, title, createdAt: T(0), updatedAt, ...extra });
const titles = (snap) => snap.todos.map((t) => t.title);

beforeEach(() => { store.init(memoryStorage()); });

test('서로 다른 기기의 항목은 모두 합쳐진다', () => {
  const pc = { todos: [todo('a', 'PC 할 일', T(1))], memos: [{ id: 'm1', title: '메모', createdAt: T(1), updatedAt: T(1) }] };
  const phone = { todos: [todo('b', '폰 할 일', T(2))], events: [{ id: 'e1', title: '회의', date: '2026-11-18', createdAt: T(2), updatedAt: T(2) }] };
  const merged = store.mergeSnapshots(pc, phone);
  assert.deepEqual(titles(merged), ['PC 할 일', '폰 할 일']);
  assert.equal(merged.memos.length, 1);
  assert.equal(merged.events.length, 1);
});

test('같은 항목은 더 최근에 고친 쪽이 이긴다', () => {
  const a = { todos: [todo('x', '옛 제목', T(1))] };
  const b = { todos: [todo('x', '새 제목', T(3), { done: true })] };
  assert.deepEqual(titles(store.mergeSnapshots(a, b)), ['새 제목']);
  assert.deepEqual(titles(store.mergeSnapshots(b, a)), ['새 제목']);
});

test('삭제는 다른 기기에서 되살아나지 않는다', () => {
  const a = { todos: [], deleted: { x: T(2) } };
  const b = { todos: [todo('x', '지운 할 일', T(1))] };
  const merged = store.mergeSnapshots(a, b);
  assert.deepEqual(merged.todos, []);
  assert.equal(merged.deleted.x, T(2));
  // 삭제 뒤에 다른 기기에서 고쳤다면 남긴다
  assert.deepEqual(titles(store.mergeSnapshots(a, { todos: [todo('x', '다시 고침', T(3))] })), ['다시 고침']);
});

test('병합은 순서와 무관하고 반복해도 같다', () => {
  const a = { todos: [todo('1', 'A', T(1)), todo('2', 'B', T(4))], deleted: { 3: T(2) }, devices: { pc01: { label: 'PC', updatedAt: T(1) } } };
  const b = { todos: [todo('2', 'B2', T(2)), todo('3', 'C', T(1))], devices: { ph01: { label: '폰', updatedAt: T(2) } } };
  const ab = store.mergeSnapshots(a, b);
  const ba = store.mergeSnapshots(b, a);
  assert.equal(store.stableStringify(ab), store.stableStringify(ba));
  assert.equal(store.stableStringify(store.mergeSnapshots(ab, b)), store.stableStringify(ab));
  assert.deepEqual(titles(ab), ['A', 'B']);
  assert.deepEqual(Object.keys(ab.devices).sort(), ['pc01', 'ph01']);
});

test('오래된 삭제 기록은 정리된다', () => {
  const merged = store.mergeSnapshots({ deleted: { old: '2026-01-01T00:00:00.000Z', recent: T(1) } }, {}, new Date(2026, 10, 18));
  assert.deepEqual(Object.keys(merged.deleted), ['recent']);
});

test('알림 키는 먼저 만든 쪽을 유지한다', () => {
  const k1 = { publicKey: 'B'.repeat(87), privateKey: 'p'.repeat(43), createdAt: T(1) };
  const k2 = { publicKey: 'A'.repeat(87), privateKey: 'q'.repeat(43), createdAt: T(2) };
  assert.equal(store.mergeSnapshots({ vapid: k2 }, { vapid: k1 }).vapid.publicKey, k1.publicKey);
  assert.equal(store.mergeSnapshots({ vapid: k1 }, { vapid: k2 }).vapid.publicKey, k1.publicKey);
  assert.equal(store.mergeSnapshots({}, { vapid: k2 }).vapid.publicKey, k2.publicKey);
});

test('수정·삭제·완료가 수정 시각과 삭제 기록을 남긴다', async () => {
  const t = store.addTodo({ title: '할 일' });
  const first = t.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  store.updateTodo(t.id, { title: '바뀐 할 일' });
  assert.ok(store.getState().todos[0].updatedAt > first);
  store.deleteTodo(t.id);
  assert.ok(store.getState().deleted[t.id]);
  const m = store.addMemo({ title: '메모' });
  store.deleteMemo(m.id);
  const e = store.addEvent({ title: '일정', date: '2026-11-18' });
  store.deleteEvent(e.id);
  assert.equal(Object.keys(store.getState().deleted).length, 3);
});

test('원격 반영 중에 이 기기에서 고친 내용은 보존된다', async () => {
  const mine = store.addTodo({ title: '내가 방금 추가' });
  const changed = store.applySnapshot({ todos: [todo('r1', '다른 기기에서 추가', T(1))] });
  assert.equal(changed, true);
  assert.deepEqual(store.getState().todos.map((x) => x.title).sort(), ['내가 방금 추가', '다른 기기에서 추가'].sort());
  assert.ok(store.getState().todos.find((x) => x.id === mine.id));
  // 같은 내용을 다시 반영하면 바뀐 것이 없다
  assert.equal(store.applySnapshot(store.syncSnapshot()), false);
});

test('설정과 브리핑 확인 여부는 동기화 대상이 아니다', () => {
  store.setSettings({ name: '다니엘', theme: 'dark' });
  store.markBriefingSeen('2026-11-18');
  const snap = store.syncSnapshot();
  assert.equal(snap.settings, undefined);
  assert.equal(snap.briefingSeen, undefined);
  store.applySnapshot({ todos: [todo('r', '원격', T(1))] });
  assert.equal(store.getState().settings.name, '다니엘');
  assert.equal(store.getState().briefingSeen, '2026-11-18');
});

test('설정 변경은 동기화를 일으키지 않는다', () => {
  const seen = [];
  store.subscribe((_, meta) => seen.push(meta.synced));
  store.setSettings({ name: 'A' });
  store.markBriefingSeen('2026-11-18');
  store.addTodo({ title: 'x' });
  assert.deepEqual(seen, [false, false, true]);
});

test('백업 복원과 전체 삭제는 다른 기기에도 삭제로 전달된다', () => {
  const keep = store.addTodo({ title: '남길 것' });
  const drop = store.addTodo({ title: '지울 것' });
  store.replaceAll({ todos: [{ ...keep }], settings: { name: 'D' } });
  assert.deepEqual(store.getState().todos.map((x) => x.title), ['남길 것']);
  assert.ok(store.getState().deleted[drop.id]);
  store.clearAll();
  assert.equal(store.getState().todos.length, 0);
  assert.ok(store.getState().deleted[keep.id]);
  const other = store.mergeSnapshots({ todos: [{ ...keep, updatedAt: T(1) }] }, store.syncSnapshot());
  assert.equal(other.todos.length, 0);
});

test('예전 형식(수정 시각 없음) 데이터도 읽는다', () => {
  const s = store.normalize({ todos: [{ id: 'o', title: '옛날', createdAt: '2026-11-01T00:00:00.000Z' }], events: [{ id: 'e', title: '옛 일정', date: '2026-11-02' }] });
  assert.equal(s.todos[0].updatedAt, '2026-11-01T00:00:00.000Z');
  assert.equal(s.events[0].updatedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual([s.deleted, s.devices, s.vapid], [{}, {}, null]);
});

test('손상된 기기·알림 정보는 버린다', () => {
  const s = store.normalize({
    devices: { 'ok-device': { label: '폰', push: { endpoint: 'http://insecure', keys: { p256dh: 'a', auth: 'b' } } }, 'bad id!': {} },
    vapid: { publicKey: 'short', privateKey: 'x' },
  });
  assert.deepEqual(Object.keys(s.devices), ['ok-device']);
  assert.equal(s.devices['ok-device'].push, null);
  assert.equal(s.vapid, null);
});
