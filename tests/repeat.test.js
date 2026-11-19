import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';
import { parseQuickInput } from '../js/nlp.js';
import { dueReminders } from '../js/reminders.js';
import { buildBriefing } from '../js/briefing.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
}
const dates = (e, from, to) => store.occurrences(store.normalize({ events: [e] }).events[0], from, to).map((o) => o.date);

beforeEach(() => { store.init(memoryStorage()); });

test('"매주 목요일 밤 11시 세차"는 매주 반복 일정이 된다', () => {
  // 기준: 2026-11-19(목) 10:00
  const p = parseQuickInput('매주 목요일 밤 11시 세차', new Date(2026, 10, 19, 10));
  assert.deepEqual([p.title, p.due, p.time, p.repeat], ['세차', '2026-11-19', '23:00', 'weekly']);
  store.addEvent({ title: p.title, date: p.due, time: p.time, repeat: p.repeat });
  const s = store.getState();
  const thursdays = store.eventsBetween(s, '2026-11-01', '2026-12-31').map((e) => e.date);
  assert.deepEqual(thursdays, ['2026-11-19', '2026-11-26', '2026-12-03', '2026-12-10', '2026-12-17', '2026-12-24', '2026-12-31']);
  assert.equal(store.eventsOn(s, '2027-03-04').length, 1, '몇 달 뒤 목요일에도 있다');
  assert.equal(store.eventsOn(s, '2026-11-20').length, 0);
});

test('매년·매월·매일 반복', () => {
  assert.equal(parseQuickInput('매년 3월 1일 결혼기념일', new Date(2026, 10, 19)).repeat, 'yearly');
  assert.deepEqual(dates({ id: 'y', title: '생일', date: '2026-12-25', repeat: 'yearly' }, '2026-01-01', '2029-12-31'),
    ['2026-12-25', '2027-12-25', '2028-12-25', '2029-12-25']);
  assert.deepEqual(dates({ id: 'm', title: '월세', date: '2026-11-25', repeat: 'monthly' }, '2027-01-01', '2027-03-31'),
    ['2027-01-25', '2027-02-25', '2027-03-25']);
  assert.deepEqual(dates({ id: 'd', title: '운동', date: '2026-11-19', repeat: 'daily' }, '2026-12-30', '2027-01-02'),
    ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
});

test('그달에 없는 날짜는 건너뛴다(31일, 2월 29일)', () => {
  assert.deepEqual(dates({ id: 'a', title: '말일', date: '2026-10-31', repeat: 'monthly' }, '2026-10-01', '2027-03-31'),
    ['2026-10-31', '2026-12-31', '2027-01-31', '2027-03-31']);
  assert.deepEqual(dates({ id: 'b', title: '윤일', date: '2024-02-29', repeat: 'yearly' }, '2024-01-01', '2032-12-31'),
    ['2024-02-29', '2028-02-29', '2032-02-29']);
});

test('반복 끝, 건너뛴 날짜, 시작 전 기간', () => {
  const e = { id: 'w', title: '수업', date: '2026-11-02', repeat: 'weekly', repeatUntil: '2026-11-30', exdates: ['2026-11-16'] };
  assert.deepEqual(dates(e, '2026-10-01', '2026-12-31'), ['2026-11-02', '2026-11-09', '2026-11-23', '2026-11-30']);
  assert.deepEqual(dates(e, '2026-10-01', '2026-10-31'), []);
});

test('여러 날 일정도 반복된다', () => {
  const e = { id: 'r', title: '주말 캠핑', date: '2026-11-21', endDate: '2026-11-22', repeat: 'weekly' };
  assert.deepEqual(dates(e, '2026-11-29', '2026-11-29'), ['2026-11-28'], '일요일에는 토요일에 시작한 회차가 걸친다');
  store.addEvent(e);
  const sunday = store.eventsOn(store.getState(), '2026-11-29')[0];
  assert.deepEqual([sunday.date, sunday.endDate, sunday.seriesDate], ['2026-11-28', '2026-11-29', '2026-11-21']);
});

test('반복 일정의 알람과 브리핑', () => {
  store.addEvent({ title: '세차', date: '2026-11-19', time: '23:00', repeat: 'weekly', remind: 10 });
  const list = dueReminders(store.getState(), new Date(2026, 10, 25), new Date(2026, 10, 27));
  assert.deepEqual(list.map((r) => [r.title, r.at.getDate(), r.at.getHours(), r.at.getMinutes()]), [['일정 · 세차', 26, 22, 50]]);
  assert.match(list[0].key, /2026-11-26|2026-11-2/);
  const b = buildBriefing(store.getState(), new Date(2026, 10, 26, 8));
  assert.deepEqual(b.sections.find((x) => x.key === 'events').items, ['오후 11시 세차']);
});

test('반복 정보 검증과 할 일 매년 반복', () => {
  const s = store.normalize({ events: [
    { id: 'x', title: '잘못', date: '2026-11-19', repeat: 'hourly', repeatUntil: '2026-12-01', exdates: ['2026-11-26'] },
    { id: 'y', title: '끝이 앞', date: '2026-11-19', repeat: 'weekly', repeatUntil: '2026-11-01' },
  ] });
  assert.deepEqual([s.events[0].repeat, s.events[0].repeatUntil, s.events[0].exdates], [null, null, []]);
  assert.equal(s.events[1].repeatUntil, null);
  const t = store.addTodo({ title: '자동차 보험 갱신', due: '2026-11-19', repeat: 'yearly' });
  assert.equal(store.toggleTodo(t.id, new Date(2026, 10, 19)).spawned.due, '2027-11-19');
});
