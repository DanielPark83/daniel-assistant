import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';
import { buildBriefing } from '../js/briefing.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
}

beforeEach(() => { store.init(memoryStorage()); });

test('여러 날 일정: 기간 안의 모든 날에 보인다', () => {
  store.addEvent({ title: '부산 출장', date: '2026-11-20', endDate: '2026-11-22', time: '09:00', endTime: '18:00' });
  const s = store.getState();
  assert.deepEqual(['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'].map((d) => store.eventsOn(s, d).length), [0, 1, 1, 1, 0]);
  assert.equal(store.eventsBetween(s, '2026-11-21', '2026-11-21').length, 1);
  assert.ok(store.isMultiDay(s.events[0]));
});

test('여러 날 일정: 종료일이 시작일보다 앞이거나 같으면 하루짜리로 본다', () => {
  const s = store.normalize({ events: [
    { id: 'a', title: '잘못', date: '2026-11-20', endDate: '2026-11-18' },
    { id: 'b', title: '같은 날', date: '2026-11-20', endDate: '2026-11-20' },
    { id: 'c', title: '형식 오류', date: '2026-11-20', endDate: '내일' },
  ] });
  assert.deepEqual(s.events.map((e) => e.endDate), [null, null, null]);
});

test('여러 날 일정: 알림은 첫날 시작 시각에만', () => {
  store.addEvent({ title: '교육', date: '2026-11-18', endDate: '2026-11-20', time: '10:00' });
  assert.equal(store.alerts(store.getState(), new Date(2026, 10, 18, 9, 30)).length, 1);
  assert.equal(store.alerts(store.getState(), new Date(2026, 10, 19, 9, 30)).length, 0);
});

test('여러 날 일정: 브리핑에 기간이 함께 나온다', () => {
  store.addEvent({ title: '부산 출장', date: '2026-11-18', endDate: '2026-11-20', time: '09:00', location: '부산' });
  const day1 = buildBriefing(store.getState(), new Date(2026, 10, 18, 8)).sections.find((x) => x.key === 'events');
  const day2 = buildBriefing(store.getState(), new Date(2026, 10, 19, 8)).sections.find((x) => x.key === 'events');
  assert.deepEqual(day1.items, ['오전 9시 부산 출장 (11/18(수)~11/20(금)) · 부산']);
  assert.deepEqual(day2.items, ['종일 부산 출장 (11/18(수)~11/20(금)) · 부산']);
});

test('여러 날 일정: 종료일도 동기화로 합쳐진다', () => {
  const merged = store.mergeSnapshots(
    { events: [{ id: 'e', title: '출장', date: '2026-11-20', createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T00:00:00.000Z' }] },
    { events: [{ id: 'e', title: '출장', date: '2026-11-20', endDate: '2026-11-22', createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T01:00:00.000Z' }] },
  );
  assert.equal(merged.events[0].endDate, '2026-11-22');
});
