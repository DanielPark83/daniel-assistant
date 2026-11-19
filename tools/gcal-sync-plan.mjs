#!/usr/bin/env node
// 앱 일정 → 구글 캘린더 동기화 계획 만들기 (한 방향: 앱 → 구글).
// Claude 예약 작업이 1시간마다 이 스크립트로 "무엇을 추가·수정·삭제할지"를 정한 뒤,
// Google Calendar 커넥터로 그대로 실행한다.
//
//   node tools/gcal-sync-plan.mjs <data/assistant.json> [existing.json]
//
// existing.json: 구글 캘린더에 이미 있는, 이 앱이 만든 일정들 [{ "id": 구글 일정 ID, "description": 설명 }]
//   (설명 마지막 줄의 "da-sync:<앱 일정 ID>:<수정 시각>" 표시로 앱 일정과 짝을 짓는다)
// 출력(JSON): { create: [일정], update: [{ id, event }], delete: [구글 ID], unchanged: 개수 }
//
// 규칙
//  - 앱에서 만든 일정만 다룬다. 구글 캘린더에서 직접 만든 일정은 건드리지 않는다(표시가 없으므로).
//  - 지난 일정은 30일 전까지만 다룬다(반복 일정은 끝나지 않았으면 계속).
//  - 구글 쪽 알림은 끈다. 알람은 앱의 알림 발송기가 보내므로 두 번 울리지 않게 한다.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { normalize } from '../js/store.js';
import { addDays, today as todayIso } from '../js/dates.js';

export const TIME_ZONE = 'Asia/Seoul';
export const MARKER = 'da-sync';
const RRULE = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };

const compact = (iso) => iso.replace(/-/g, '');
const pad = (n) => String(n).padStart(2, '0');

function plusMinutes(date, time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  if (total >= 24 * 60) return { date, time: '23:59' }; // 자정을 넘기지 않는다
  return { date, time: `${pad(Math.floor(total / 60))}:${pad(total % 60)}` };
}

export function markerLine(e) {
  return `${MARKER}:${e.id}:${e.updatedAt}`;
}

export function parseMarker(description) {
  const m = new RegExp(`${MARKER}:([\\w-]+):(\\S+)`).exec(description || '');
  return m ? { appId: m[1], version: m[2] } : null;
}

// 앱 일정 하나 → 구글 캘린더 일정
export function toGoogleEvent(e) {
  const lastDay = e.endDate && e.endDate > e.date ? e.endDate : e.date;
  const ev = {
    summary: e.title,
    description: [e.notes, '개인 비서 앱에서 옮겨 온 일정입니다. 수정·삭제는 앱에서 해 주세요.', markerLine(e)].filter(Boolean).join('\n\n'),
    reminders: { useDefault: false, overrides: [] },
  };
  if (e.location) ev.location = e.location;

  if (!e.time) {
    // 종일: 끝 날짜는 다음 날(구글 규칙)
    ev.start = { date: e.date };
    ev.end = { date: addDays(lastDay, 1) };
  } else {
    ev.start = { dateTime: `${e.date}T${e.time}:00`, timeZone: TIME_ZONE };
    let end;
    if (e.endTime && (lastDay > e.date || e.endTime > e.time)) end = { date: lastDay, time: e.endTime };
    else if (lastDay > e.date) end = { date: lastDay, time: e.time };
    else end = plusMinutes(e.date, e.time, 60);
    ev.end = { dateTime: `${end.date}T${end.time}:00`, timeZone: TIME_ZONE };
  }

  if (e.repeat) {
    let rule = `RRULE:FREQ=${RRULE[e.repeat]}`;
    // 반복 끝: 종일은 날짜, 시간 일정은 그날 23:59:59(한국) = 14:59:59 UTC
    if (e.repeatUntil) rule += e.time ? `;UNTIL=${compact(e.repeatUntil)}T145959Z` : `;UNTIL=${compact(e.repeatUntil)}`;
    ev.recurrence = [rule];
    if (e.exdates && e.exdates.length) {
      ev.recurrence.push(e.time
        ? `EXDATE;TZID=${TIME_ZONE}:${e.exdates.map((d) => `${compact(d)}T${e.time.replace(':', '')}00`).join(',')}`
        : `EXDATE;VALUE=DATE:${e.exdates.map(compact).join(',')}`);
    }
  }
  return ev;
}

// 동기화할 앱 일정: 30일 전 이후에 끝나는 일정 + 아직 끝나지 않은 반복 일정
export function syncableEvents(state, today = todayIso()) {
  const from = addDays(today, -30);
  return state.events.filter((e) => {
    if (e.repeat) return !e.repeatUntil || e.repeatUntil >= from;
    return (e.endDate && e.endDate > e.date ? e.endDate : e.date) >= from;
  });
}

export function plan(state, existing = [], today = todayIso()) {
  const desired = new Map(syncableEvents(state, today).map((e) => [e.id, e]));
  const seen = new Set();
  const out = { create: [], update: [], delete: [], unchanged: 0 };
  existing.forEach((g) => {
    const mark = parseMarker(g.description);
    if (!mark) return; // 앱이 만든 일정이 아니면 건드리지 않는다
    const e = desired.get(mark.appId);
    if (!e || seen.has(mark.appId)) { out.delete.push(g.id); return; } // 앱에서 지웠거나 중복
    seen.add(mark.appId);
    if (mark.version === e.updatedAt) out.unchanged += 1;
    else out.update.push({ id: g.id, appId: e.id, event: toGoogleEvent(e) });
  });
  desired.forEach((e, id) => { if (!seen.has(id)) out.create.push({ appId: id, event: toGoogleEvent(e) }); });
  return out;
}

async function main() {
  process.env.TZ = process.env.TZ || TIME_ZONE; // '오늘'을 한국 날짜로 계산한다
  const [dataPath, existingPath] = process.argv.slice(2);
  if (!dataPath) {
    console.error('사용법: node tools/gcal-sync-plan.mjs <data/assistant.json> [existing.json]');
    process.exit(2);
  }
  const state = normalize(JSON.parse(await readFile(dataPath, 'utf8')));
  const existing = existingPath ? JSON.parse(await readFile(existingPath, 'utf8')) : [];
  console.log(JSON.stringify(plan(state, Array.isArray(existing) ? existing : []), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
