// 할 일·일정 알람("10분 전" 등).
// 알람 시각 계산은 순수 함수라 앱과 서버(나중에 붙일 발송기)가 함께 쓴다.

import { fromISODate, diffDays, toISODate, formatShort, formatTime } from './dates.js';
import { occurrences } from './store.js';

// [분, 이름]. null = 알림 없음, 0 = 정시
export const REMIND_OPTIONS = [
  [null, '알림 없음'], [0, '정시'], [5, '5분 전'], [10, '10분 전'], [15, '15분 전'], [30, '30분 전'],
  [60, '1시간 전'], [120, '2시간 전'], [1440, '하루 전'],
];

// 시간이 없는 할 일·종일 일정은 이 시각을 기준으로 알린다
export const ALL_DAY_BASE = '09:00';

export function remindLabel(m) {
  const opt = REMIND_OPTIONS.find(([v]) => v === m);
  if (opt) return opt[1];
  if (m % 1440 === 0) return `${m / 1440}일 전`;
  if (m % 60 === 0) return `${m / 60}시간 전`;
  return `${m}분 전`;
}

const dateOf = (item, kind) => (kind === 'todo' ? item.due : item.date);

function baseTime(item, kind) {
  const date = dateOf(item, kind);
  if (!date) return null;
  const [h, mi] = (item.time || ALL_DAY_BASE).split(':').map(Number);
  const d = fromISODate(date);
  d.setHours(h, mi, 0, 0);
  return d;
}

// 알람이 울릴 시각(Date). 알림이 없거나, 끝난 할 일이거나, 날짜가 없으면 null
export function fireAt(item, kind) {
  if (item.remind == null || (kind === 'todo' && item.done)) return null;
  const base = baseTime(item, kind);
  return base ? new Date(base.getTime() - item.remind * 60000) : null;
}

function relative(item, kind, at) {
  const date = dateOf(item, kind);
  const dayGap = diffDays(date, toISODate(at));
  const day = dayGap === 0 ? '오늘' : dayGap === 1 ? '내일' : formatShort(date);
  if (!item.time) return day;
  if (dayGap > 0) return `${day} ${formatTime(item.time)}`;
  const mins = item.remind;
  if (mins === 0) return `지금(${formatTime(item.time)})`;
  const ahead = mins % 60 === 0 ? `${mins / 60}시간 후` : `${mins}분 후`;
  return `${ahead}(${formatTime(item.time)})`;
}

function message(item, kind, at) {
  const when = relative(item, kind, at);
  if (kind === 'event') {
    const multi = item.endDate && item.endDate > item.date ? ` ~ ${formatShort(item.endDate)}` : '';
    const start = item.time ? `${when} 시작` : `${when} 종일 일정${multi}`;
    return {
      title: `일정 · ${item.title}`,
      body: [start, item.location].filter(Boolean).join(' · '),
    };
  }
  return {
    title: `할 일 · ${item.title}`,
    body: `${when} 마감${item.priority === 'high' ? ' · 중요' : ''}`,
  };
}

// from < 울릴 시각 <= to 인 알람 목록(시각순). key는 기기·서버가 같은 알람을 구분하는 값이다.
export function dueReminders(state, from, to) {
  const out = [];
  const add = (item, kind) => {
    const at = fireAt(item, kind);
    if (!at || at <= from || at > to) return;
    out.push({
      key: `${kind}:${item.id}:${at.toISOString()}`,
      kind, id: item.id, at, url: kind === 'event' ? './#calendar' : './#todos',
      ...message(item, kind, at),
    });
  };
  state.todos.forEach((t) => add(t, 'todo'));
  // 일정은 회차마다(반복 일정 포함). 알람이 하루 이상 앞설 수 있으니 기간을 넉넉히 잡는다
  state.events.forEach((e) => {
    if (e.remind == null) return;
    const lead = Math.ceil(e.remind / 1440) + 1;
    const toDay = new Date(to.getTime() + lead * 86400000);
    occurrences(e, toISODate(from), toISODate(toDay)).forEach((o) => add({ ...e, date: o.date, endDate: o.endDate }, 'event'));
  });
  return out.sort((a, b) => a.at - b.at || a.title.localeCompare(b.title));
}

// ───────── 앱이 켜져 있는 동안 알람 울리기 ─────────

const FIRED_KEY = 'daniel-assistant.reminders-fired';
const LATE_WINDOW = 15 * 60000; // 앱을 늦게 열었으면 15분 안에 지난 알람까지 알려 준다

function loadFired(storage) {
  try { return JSON.parse(storage.getItem(FIRED_KEY)) || {}; } catch { return {}; }
}

function saveFired(storage, fired) {
  const cutoff = Date.now() - 2 * 86400000;
  const kept = Object.fromEntries(Object.entries(fired).filter(([, at]) => Date.parse(at) > cutoff));
  try { storage.setItem(FIRED_KEY, JSON.stringify(kept)); } catch { /* 무시 */ }
}

// getState(): 현재 상태, notify(reminder, { late }): 알리기. 반환값 check(): 지금 확인하고 다음 알람을 예약
export function createLocalReminders({ storage, getState, notify }) {
  let timer = null;
  const check = () => {
    clearTimeout(timer);
    const now = Date.now();
    const fired = loadFired(storage);
    const list = dueReminders(getState(), new Date(now - LATE_WINDOW), new Date(now + 3 * 86400000))
      .filter((r) => !fired[r.key]);
    let changed = false;
    list.filter((r) => r.at.getTime() <= now).forEach((r) => {
      fired[r.key] = r.at.toISOString();
      changed = true;
      notify(r, { late: now - r.at.getTime() > 90000 });
    });
    if (changed) saveFired(storage, fired);
    const next = list.find((r) => r.at.getTime() > now);
    if (next) timer = setTimeout(check, Math.min(next.at.getTime() - now + 200, 6 * 3600000));
  };
  return check;
}
