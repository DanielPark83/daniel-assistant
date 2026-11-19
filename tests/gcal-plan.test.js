import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGoogleEvent, plan, parseMarker, markerLine } from '../tools/gcal-sync-plan.mjs';
import { normalize } from '../js/store.js';

const U = '2026-11-19T01:00:00.000Z';
const ev = (fields) => ({ id: 'e1', title: '일정', createdAt: U, updatedAt: U, ...fields });

test('시간 일정: 한국 시간, 끝 시간 없으면 1시간', () => {
  const g = toGoogleEvent(normalize({ events: [ev({ title: '고객 미팅', date: '2026-11-20', time: '14:00', location: '회의실 B', notes: '자료 준비' })] }).events[0]);
  assert.deepEqual(g.start, { dateTime: '2026-11-20T14:00:00', timeZone: 'Asia/Seoul' });
  assert.deepEqual(g.end, { dateTime: '2026-11-20T15:00:00', timeZone: 'Asia/Seoul' });
  assert.equal(g.summary, '고객 미팅');
  assert.equal(g.location, '회의실 B');
  assert.match(g.description, /^자료 준비\n\n/);
  assert.deepEqual(parseMarker(g.description), { appId: 'e1', version: U });
  assert.deepEqual(g.reminders, { useDefault: false, overrides: [] }, '알람은 앱 발송기가 보낸다');
  // 밤 11시 30분 시작이면 자정을 넘기지 않는다
  const late = toGoogleEvent(normalize({ events: [ev({ date: '2026-11-20', time: '23:30' })] }).events[0]);
  assert.equal(late.end.dateTime, '2026-11-20T23:59:00');
});

test('종일·여러 날 일정: 구글은 끝 날짜가 다음 날', () => {
  const allDay = toGoogleEvent(normalize({ events: [ev({ date: '2026-11-20' })] }).events[0]);
  assert.deepEqual([allDay.start, allDay.end], [{ date: '2026-11-20' }, { date: '2026-11-21' }]);
  const trip = toGoogleEvent(normalize({ events: [ev({ date: '2026-11-20', endDate: '2026-11-22' })] }).events[0]);
  assert.deepEqual([trip.start, trip.end], [{ date: '2026-11-20' }, { date: '2026-11-23' }]);
  const timed = toGoogleEvent(normalize({ events: [ev({ date: '2026-11-20', endDate: '2026-11-22', time: '09:00', endTime: '18:00' })] }).events[0]);
  assert.deepEqual([timed.start.dateTime, timed.end.dateTime], ['2026-11-20T09:00:00', '2026-11-22T18:00:00']);
});

test('반복 일정: 매주 목요일 밤 11시 세차, 반복 끝·건너뛴 날', () => {
  const g = toGoogleEvent(normalize({ events: [ev({
    title: '세차', date: '2026-11-19', time: '23:00', repeat: 'weekly', repeatUntil: '2027-03-31', exdates: ['2026-12-10'],
  })] }).events[0]);
  assert.deepEqual(g.recurrence, ['RRULE:FREQ=WEEKLY;UNTIL=20270331T145959Z', 'EXDATE;TZID=Asia/Seoul:20261210T230000']);
  const yearly = toGoogleEvent(normalize({ events: [ev({ date: '2026-12-25', repeat: 'yearly', exdates: ['2027-12-25'] })] }).events[0]);
  assert.deepEqual(yearly.recurrence, ['RRULE:FREQ=YEARLY', 'EXDATE;VALUE=DATE:20271225']);
});

test('계획: 새로 만들기·고치기·지우기·그대로', () => {
  const state = normalize({
    events: [
      ev({ id: 'new', title: '새 일정', date: '2026-11-25' }),
      ev({ id: 'same', title: '그대로', date: '2026-11-26' }),
      ev({ id: 'changed', title: '바뀐 제목', date: '2026-11-27', updatedAt: '2026-11-19T05:00:00.000Z' }),
      ev({ id: 'old', title: '오래전 일정', date: '2026-09-01' }),
      ev({ id: 'oldrepeat', title: '계속 반복', date: '2025-01-06', repeat: 'weekly' }),
    ],
  });
  const existing = [
    { id: 'g-same', description: `설명\n\n${markerLine({ id: 'same', updatedAt: U })}` },
    { id: 'g-changed', description: markerLine({ id: 'changed', updatedAt: U }) },
    { id: 'g-deleted', description: markerLine({ id: 'deleted-in-app', updatedAt: U }) },
    { id: 'g-dup', description: markerLine({ id: 'same', updatedAt: U }) },
    { id: 'g-mine', description: '구글 캘린더에서 직접 만든 일정' },
  ];
  const p = plan(state, existing, '2026-11-19');
  assert.deepEqual(p.create.map((c) => c.appId).sort(), ['new', 'oldrepeat']);
  assert.deepEqual(p.update.map((u) => [u.id, u.appId, u.event.summary]), [['g-changed', 'changed', '바뀐 제목']]);
  assert.deepEqual(p.delete.sort(), ['g-deleted', 'g-dup']);
  assert.equal(p.unchanged, 1);
  assert.ok(!p.delete.includes('g-mine'), '직접 만든 일정은 건드리지 않는다');
});

test('처음 실행(구글에 아무것도 없음)', () => {
  const p = plan(normalize({ events: [ev({ date: '2026-11-25' })] }), [], '2026-11-19');
  assert.equal(p.create.length, 1);
  assert.deepEqual([p.update.length, p.delete.length, p.unchanged], [0, 0, 0]);
});
