import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';
import { fireAt, dueReminders, remindLabel, createLocalReminders } from '../js/reminders.js';

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m);
function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
}

test('알람 시각: 시간 있는 일정·할 일, 종일은 오전 9시 기준', () => {
  assert.deepEqual(fireAt({ date: '2026-11-20', time: '15:00', remind: 10 }, 'event'), at(20, 14, 50));
  assert.deepEqual(fireAt({ due: '2026-11-20', time: '15:00', remind: 0 }, 'todo'), at(20, 15));
  assert.deepEqual(fireAt({ due: '2026-11-20', time: null, remind: 1440 }, 'todo'), at(19, 9));
  assert.equal(fireAt({ due: '2026-11-20', time: '15:00', remind: null }, 'todo'), null);
  assert.equal(fireAt({ due: '2026-11-20', time: '15:00', remind: 10, done: true }, 'todo'), null);
  assert.equal(fireAt({ due: null, remind: 10 }, 'todo'), null);
});

test('알람 문구', () => {
  const state = store.normalize({
    todos: [
      { id: 't1', title: '보고서 제출', due: '2026-11-20', time: '15:00', remind: 30, priority: 'high' },
      { id: 't2', title: '카드값', due: '2026-11-21', remind: 1440 },
    ],
    events: [
      { id: 'e1', title: '고객 미팅', date: '2026-11-20', time: '14:00', remind: 10, location: '회의실 B' },
      { id: 'e2', title: '부산 출장', date: '2026-11-20', endDate: '2026-11-22', remind: 0 },
      { id: 'e3', title: '알람 없음', date: '2026-11-20', time: '10:00' },
    ],
  });
  const list = dueReminders(state, at(20, 0), at(20, 23, 59));
  assert.deepEqual(list.map((r) => [r.title, r.body, r.at.getHours() * 60 + r.at.getMinutes()]), [
    ['일정 · 부산 출장', '오늘 종일 일정 ~ 11/22(일)', 540],
    ['할 일 · 카드값', '내일 마감', 540],
    ['일정 · 고객 미팅', '10분 후(오후 2시) 시작 · 회의실 B', 830],
    ['할 일 · 보고서 제출', '30분 후(오후 3시) 마감 · 중요', 870],
  ]);
  assert.match(list[0].key, /^event:e2:/);
  assert.equal(remindLabel(1440), '하루 전');
  assert.equal(remindLabel(90), '90분 전');
});

test('알람은 동기화 데이터에 함께 저장된다', () => {
  const s = store.normalize({ todos: [{ id: 'a', title: 'x', remind: 15 }, { id: 'b', title: 'y', remind: -5 }, { id: 'c', title: 'z', remind: '10' }] });
  assert.deepEqual(s.todos.map((t) => t.remind), [15, null, null]);
});

test('앱 안의 알람: 제때 한 번만, 늦게 열면 15분까지 지난 알람도', async () => {
  const storage = memoryStorage();
  const now = Date.now();
  const iso = (ms) => { const d = new Date(ms); return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }; };
  // 5분 전에 울렸어야 할 알람, 1시간 전에 울렸어야 할 알람(너무 지남), 1분 뒤 알람
  const late = iso(now - 5 * 60000 + 10 * 60000);
  const tooOld = iso(now - 60 * 60000 + 10 * 60000);
  const state = store.normalize({ events: [
    { id: 'late', title: '늦은 알람', ...late, remind: 10 },
    { id: 'old', title: '너무 지난 알람', ...tooOld, remind: 10 },
  ] });
  const got = [];
  const check = createLocalReminders({ storage, getState: () => state, notify: (r, o) => got.push([r.id, o.late]) });
  check();
  check(); // 다시 확인해도 두 번 울리지 않는다
  assert.deepEqual(got, [['late', true]]);
  const again = createLocalReminders({ storage, getState: () => state, notify: (r) => got.push([r.id]) });
  again(); // 앱을 다시 열어도(같은 저장소) 다시 울리지 않는다
  assert.equal(got.length, 1);
});
