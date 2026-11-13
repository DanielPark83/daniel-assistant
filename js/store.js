// 앱 상태 저장소. 모든 데이터는 이 기기의 localStorage에만 저장된다.

import { today, addDays, addMonths, diffDays, toISODate } from './dates.js';

const KEY = 'daniel-assistant.v1';
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

export const BRIEFING_TAG = '브리핑';

export function defaultState() {
  return {
    version: 1,
    settings: { name: 'Daniel', theme: 'auto' },
    todos: [],
    events: [],
    memos: [],
    briefingSeen: null,
  };
}

let state = defaultState();
const listeners = new Set();
let storage = null;

export function init(storageImpl) {
  storage = storageImpl || null;
  state = defaultState();
  if (storage) {
    try {
      const raw = storage.getItem(KEY);
      if (raw) state = normalize(JSON.parse(raw));
    } catch (err) {
      console.warn('저장된 데이터를 읽지 못했습니다.', err);
    }
  }
  return state;
}

// 외부에서 들어온 데이터(백업 파일 등)를 안전한 형태로 맞춘다.
export function normalize(data) {
  const base = defaultState();
  if (!data || typeof data !== 'object') return base;
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const str = (v, d = '') => (typeof v === 'string' ? v : d);
  const isoOrNull = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const timeOrNull = (v) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null);
  const tags = (v) => (Array.isArray(v) ? v.filter((t) => typeof t === 'string' && t) : []);
  return {
    version: 1,
    settings: { ...base.settings, ...(data.settings && typeof data.settings === 'object' ? {
      name: str(data.settings.name, 'Daniel') || 'Daniel',
      theme: ['auto', 'light', 'dark'].includes(data.settings.theme) ? data.settings.theme : 'auto',
    } : {}) },
    todos: arr(data.todos).map((t) => ({
      id: str(t.id) || uid(),
      title: str(t.title, '(제목 없음)'),
      due: isoOrNull(t.due),
      time: timeOrNull(t.time),
      priority: t.priority in PRIORITY_RANK ? t.priority : 'medium',
      tags: tags(t.tags),
      notes: str(t.notes),
      repeat: ['daily', 'weekly', 'monthly'].includes(t.repeat) ? t.repeat : null,
      done: !!t.done,
      doneAt: str(t.doneAt) || null,
      createdAt: str(t.createdAt) || new Date().toISOString(),
      originalDue: isoOrNull(t.originalDue),
      postponed: Number.isInteger(t.postponed) ? t.postponed : 0,
    })),
    events: arr(data.events).filter((e) => isoOrNull(e.date)).map((e) => ({
      id: str(e.id) || uid(),
      title: str(e.title, '(제목 없음)'),
      date: e.date,
      time: timeOrNull(e.time),
      endTime: timeOrNull(e.endTime),
      location: str(e.location),
      notes: str(e.notes),
    })),
    memos: arr(data.memos).map((m) => ({
      id: str(m.id) || uid(),
      title: str(m.title),
      body: str(m.body),
      tags: tags(m.tags),
      pinned: !!m.pinned,
      createdAt: str(m.createdAt) || new Date().toISOString(),
      updatedAt: str(m.updatedAt) || new Date().toISOString(),
    })),
    briefingSeen: isoOrNull(data.briefingSeen),
  };
}

export function getState() { return state; }

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function commit() {
  if (storage) {
    try { storage.setItem(KEY, JSON.stringify(state)); } catch (err) { console.warn('저장 실패', err); }
  }
  listeners.forEach((fn) => fn(state));
}

export function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ───────── 할 일 ─────────

export function addTodo(fields) {
  const todo = {
    id: uid(), title: '', due: null, time: null, priority: 'medium', tags: [], notes: '', repeat: null,
    done: false, doneAt: null, createdAt: new Date().toISOString(), originalDue: null, postponed: 0,
    ...fields,
  };
  todo.originalDue = todo.due;
  state.todos.push(todo);
  commit();
  return todo;
}

export function updateTodo(id, fields) {
  const t = state.todos.find((x) => x.id === id);
  if (!t) return null;
  Object.assign(t, fields);
  commit();
  return t;
}

export function deleteTodo(id) {
  state.todos = state.todos.filter((x) => x.id !== id);
  commit();
}

function nextDue(due, repeat, todayIso) {
  const base = due && diffDays(due, todayIso) > 0 ? due : todayIso;
  if (repeat === 'daily') return addDays(base, 1);
  if (repeat === 'weekly') {
    // 원래 요일을 유지한다
    let next = addDays(due || todayIso, 7);
    while (diffDays(next, todayIso) <= 0) next = addDays(next, 7);
    return next;
  }
  let next = addMonths(due || todayIso, 1);
  while (diffDays(next, todayIso) <= 0) next = addMonths(next, 1);
  return next;
}

// 완료 토글. 반복 할 일은 완료 시 다음 회차를 새로 만든다.
export function toggleTodo(id, now = new Date()) {
  const t = state.todos.find((x) => x.id === id);
  if (!t) return null;
  t.done = !t.done;
  t.doneAt = t.done ? now.toISOString() : null;
  let spawned = null;
  if (t.done && t.repeat) {
    const due = nextDue(t.due, t.repeat, toISODate(now));
    spawned = {
      ...t, id: uid(), done: false, doneAt: null, due, originalDue: due, postponed: 0,
      tags: [...t.tags], createdAt: now.toISOString(),
    };
    t.repeat = null; // 완료된 회차는 더 이상 반복을 만들지 않는다
    state.todos.push(spawned);
  }
  commit();
  return { todo: t, spawned };
}

// 미루기: 마감일을 옮기고 미룬 횟수를 기록한다.
export function postponeTodo(id, toIso) {
  const t = state.todos.find((x) => x.id === id);
  if (!t) return null;
  if (!t.originalDue) t.originalDue = t.due;
  t.due = toIso;
  t.postponed = (t.postponed || 0) + 1;
  commit();
  return t;
}

// ───────── 일정 ─────────

export function addEvent(fields) {
  const ev = { id: uid(), title: '', date: today(), time: null, endTime: null, location: '', notes: '', ...fields };
  state.events.push(ev);
  commit();
  return ev;
}

export function updateEvent(id, fields) {
  const e = state.events.find((x) => x.id === id);
  if (!e) return null;
  Object.assign(e, fields);
  commit();
  return e;
}

export function deleteEvent(id) {
  state.events = state.events.filter((x) => x.id !== id);
  commit();
}

// ───────── 메모 ─────────

export function addMemo(fields) {
  const now = new Date().toISOString();
  const memo = { id: uid(), title: '', body: '', tags: [], pinned: false, createdAt: now, updatedAt: now, ...fields };
  state.memos.push(memo);
  commit();
  return memo;
}

export function updateMemo(id, fields) {
  const m = state.memos.find((x) => x.id === id);
  if (!m) return null;
  Object.assign(m, fields, { updatedAt: new Date().toISOString() });
  commit();
  return m;
}

export function deleteMemo(id) {
  state.memos = state.memos.filter((x) => x.id !== id);
  commit();
}

// ───────── 설정·백업 ─────────

export function setSettings(fields) {
  Object.assign(state.settings, fields);
  commit();
}

export function markBriefingSeen(iso) {
  if (state.briefingSeen === iso) return;
  state.briefingSeen = iso;
  commit();
}

export function replaceAll(data) {
  state = normalize(data);
  commit();
}

export function mergeTodos(todos) {
  todos.forEach((t) => {
    state.todos.push({
      id: uid(), title: '', due: null, time: null, priority: 'medium', tags: [], notes: '', repeat: null,
      done: false, doneAt: null, createdAt: new Date().toISOString(), postponed: 0, ...t, originalDue: t.due || null,
    });
  });
  commit();
}

export function clearAll() {
  state = defaultState();
  commit();
}

// ───────── 조회(순수 함수) ─────────

export function compareTodos(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (a.done) return (b.doneAt || '').localeCompare(a.doneAt || '');
  if ((a.due || '9999') !== (b.due || '9999')) return (a.due || '9999').localeCompare(b.due || '9999');
  if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if ((a.time || '99') !== (b.time || '99')) return (a.time || '99').localeCompare(b.time || '99');
  return a.createdAt.localeCompare(b.createdAt);
}

export function overdueTodos(s, todayIso) {
  return s.todos.filter((t) => !t.done && t.due && t.due < todayIso).sort(compareTodos);
}

export function todosDueOn(s, iso) {
  return s.todos.filter((t) => !t.done && t.due === iso).sort(compareTodos);
}

export function todosDoneOn(s, iso) {
  return s.todos.filter((t) => t.done && t.doneAt && toISODate(new Date(t.doneAt)) === iso);
}

// 일정을 조회용 형태로 맞춘다.
export function allEvents(s) {
  return s.events.map((e) => ({ ...e, endDate: e.date, allDay: !e.time }));
}

export function compareEvents(a, b) {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  return (a.time || '').localeCompare(b.time || '');
}

export function eventsOn(s, iso) {
  return allEvents(s)
    .filter((e) => e.date <= iso && iso <= e.endDate)
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

// from 이상 to 이하에 걸치는 일정
export function eventsBetween(s, from, to) {
  return allEvents(s).filter((e) => e.endDate >= from && e.date <= to).sort(compareEvents);
}

// 중요 알림: 지연된 할 일, 오늘·내일 마감인 높은 중요도, 여러 번 미룬 항목, 곧 시작하는 일정
export function alerts(s, now = new Date()) {
  const t = toISODate(now);
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const list = [];
  const seen = new Set();
  const push = (kind, level, ref, text, detail) => {
    const key = `${ref.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ kind, level, id: ref.id, text, detail });
  };

  eventsOn(s, t).forEach((e) => {
    if (!e.time || e.time < hm) return;
    const mins = (Number(e.time.slice(0, 2)) * 60 + Number(e.time.slice(3))) - (now.getHours() * 60 + now.getMinutes());
    if (mins <= 60) push('event', 'warning', e, e.title, mins <= 0 ? '지금 시작' : `${mins}분 후 시작`);
  });
  overdueTodos(s, t).forEach((todo) => {
    push('todo', 'critical', todo, todo.title, `${diffDays(t, todo.due)}일 지연`);
  });
  s.todos.filter((x) => !x.done && x.priority === 'high' && x.due && diffDays(x.due, t) >= 0 && diffDays(x.due, t) <= 1)
    .sort(compareTodos)
    .forEach((todo) => push('todo', 'warning', todo, todo.title, todo.due === t ? '오늘 마감 · 중요' : '내일 마감 · 중요'));
  s.todos.filter((x) => !x.done && (x.postponed || 0) >= 3)
    .forEach((todo) => push('todo', 'warning', todo, todo.title, `${todo.postponed}번 미룸`));
  return list;
}

export function searchMemos(s, query, tag) {
  const q = (query || '').trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  return s.memos
    .filter((m) => !tag || m.tags.includes(tag))
    .filter((m) => {
      if (!words.length) return true;
      const hay = `${m.title}\n${m.body}\n${m.tags.map((x) => `#${x}`).join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt.localeCompare(a.updatedAt)));
}

export function allTags(items) {
  const counts = new Map();
  items.forEach((it) => it.tags.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}
