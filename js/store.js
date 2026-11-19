// 앱 상태 저장소. 데이터는 이 기기의 localStorage에 저장되고,
// 동기화를 연결하면 sync.js가 다른 기기와 병합한다.
//
// 병합 규칙
//  - 할 일·일정·메모는 항목마다 updatedAt을 가지며, 같은 항목이면 더 최근에 고친 쪽이 이긴다.
//  - 삭제는 deleted[id] = 삭제 시각(툼스톤)으로 남겨, 다른 기기에서 되살아나지 않게 한다.
//  - 설정(이름·테마)과 브리핑 확인 여부는 기기마다 따로 둔다.

import { today, addDays, addMonths, diffDays, toISODate } from './dates.js';

const KEY = 'daniel-assistant.v1';
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const EPOCH = '1970-01-01T00:00:00.000Z';
const TOMBSTONE_DAYS = 180;
const COLLECTIONS = ['todos', 'events', 'memos'];
export const REPEATS = ['daily', 'weekly', 'monthly', 'yearly'];
// 동기화 파일의 최상위 키 중 이 버전이 아는 것. 모르는 키는 그대로 보존한다.
const KNOWN_KEYS = new Set(['format', 'version', 'settings', 'briefingSeen', 'extras', ...COLLECTIONS, 'deleted', 'devices', 'vapid']);

export const BRIEFING_TAG = '브리핑';
export const SYNC_FORMAT = 1;

const nowIso = () => new Date().toISOString();

export function defaultState() {
  return {
    version: 1,
    settings: { name: 'Daniel', theme: 'auto' },
    todos: [],
    events: [],
    memos: [],
    deleted: {},
    devices: {},
    vapid: null,
    extras: {}, // 더 새 버전의 앱이 추가한 데이터(이 버전은 쓰지 않지만 지우지 않는다)
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

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, d = '') => (typeof v === 'string' ? v : d);
const stamp = (v, d = EPOCH) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) ? v : d);

function normalizeDevices(v) {
  const out = {};
  if (!isObj(v)) return out;
  Object.entries(v).forEach(([id, d]) => {
    if (!isObj(d) || !/^[\w-]{4,64}$/.test(id)) return;
    const p = d.push;
    const push = isObj(p) && /^https:\/\//.test(str(p.endpoint)) && isObj(p.keys)
      && str(p.keys.p256dh) && str(p.keys.auth)
      ? { endpoint: p.endpoint, keys: { p256dh: p.keys.p256dh, auth: p.keys.auth } }
      : null;
    out[id] = { label: str(d.label, '기기').slice(0, 40), push, vapidKey: str(d.vapidKey) || null, updatedAt: stamp(d.updatedAt) };
  });
  return out;
}

function normalizeVapid(v) {
  if (!isObj(v)) return null;
  const pub = str(v.publicKey);
  const priv = str(v.privateKey);
  if (!/^[\w-]{80,100}$/.test(pub) || !/^[\w-]{40,50}$/.test(priv)) return null;
  return { publicKey: pub, privateKey: priv, createdAt: stamp(v.createdAt) };
}

function normalizeDeleted(v) {
  const out = {};
  if (!isObj(v)) return out;
  Object.entries(v).forEach(([id, at]) => { if (id && typeof at === 'string') out[id] = stamp(at); });
  return out;
}

// 더 새 버전의 앱이 항목에 추가한 필드는 남겨 둔다(아는 필드만 검증해 덮어쓴다).
const keepExtra = (x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined));

function extrasOf(data) {
  const out = isObj(data.extras) ? { ...data.extras } : {};
  Object.keys(data).forEach((k) => { if (!KNOWN_KEYS.has(k)) out[k] = data[k]; });
  return out;
}

// 외부에서 들어온 데이터(백업 파일, 동기화 파일 등)를 안전한 형태로 맞춘다.
export function normalize(data) {
  const base = defaultState();
  if (!isObj(data)) return base;
  const arr = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
  const isoOrNull = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const timeOrNull = (v) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null);
  const tags = (v) => (Array.isArray(v) ? v.filter((t) => typeof t === 'string' && t) : []);
  // 알람: 몇 분 전(0 = 정시, 최대 1주일 전), 없으면 null
  const remindOrNull = (v) => (Number.isInteger(v) && v >= 0 && v <= 10080 ? v : null);
  return {
    version: 1,
    settings: { ...base.settings, ...(isObj(data.settings) ? {
      name: str(data.settings.name, 'Daniel') || 'Daniel',
      theme: ['auto', 'light', 'dark'].includes(data.settings.theme) ? data.settings.theme : 'auto',
    } : {}) },
    todos: arr(data.todos).map((t) => {
      const createdAt = stamp(t.createdAt, stamp(t.updatedAt));
      return {
        ...keepExtra(t),
        id: str(t.id) || uid(),
        title: str(t.title, '(제목 없음)'),
        due: isoOrNull(t.due),
        time: timeOrNull(t.time),
        priority: t.priority in PRIORITY_RANK ? t.priority : 'medium',
        tags: tags(t.tags),
        notes: str(t.notes),
        repeat: REPEATS.includes(t.repeat) ? t.repeat : null,
        done: !!t.done,
        doneAt: str(t.doneAt) || null,
        createdAt,
        updatedAt: stamp(t.updatedAt, createdAt),
        originalDue: isoOrNull(t.originalDue),
        postponed: Number.isInteger(t.postponed) ? t.postponed : 0,
        remind: remindOrNull(t.remind),
      };
    }),
    events: arr(data.events).filter((e) => isoOrNull(e.date)).map((e) => {
      const createdAt = stamp(e.createdAt, stamp(e.updatedAt));
      return {
        ...keepExtra(e),
        id: str(e.id) || uid(),
        title: str(e.title, '(제목 없음)'),
        date: e.date,
        time: timeOrNull(e.time),
        endTime: timeOrNull(e.endTime),
        // 여러 날 일정의 마지막 날(하루짜리면 null)
        endDate: isoOrNull(e.endDate) && e.endDate > e.date ? e.endDate : null,
        remind: remindOrNull(e.remind),
        // 반복: 매일·매주·매월·매년, 반복 끝나는 날(없으면 계속), 건너뛴 날짜들
        repeat: REPEATS.includes(e.repeat) ? e.repeat : null,
        repeatUntil: REPEATS.includes(e.repeat) && isoOrNull(e.repeatUntil) && e.repeatUntil >= e.date ? e.repeatUntil : null,
        exdates: REPEATS.includes(e.repeat) && Array.isArray(e.exdates) ? [...new Set(e.exdates.filter((d) => isoOrNull(d)))].sort() : [],
        location: str(e.location),
        notes: str(e.notes),
        createdAt,
        updatedAt: stamp(e.updatedAt, createdAt),
      };
    }),
    memos: arr(data.memos).map((m) => {
      const createdAt = stamp(m.createdAt, stamp(m.updatedAt));
      return {
        ...keepExtra(m),
        id: str(m.id) || uid(),
        title: str(m.title),
        body: str(m.body),
        tags: tags(m.tags),
        pinned: !!m.pinned,
        createdAt,
        updatedAt: stamp(m.updatedAt, createdAt),
      };
    }),
    deleted: normalizeDeleted(data.deleted),
    devices: normalizeDevices(data.devices),
    vapid: normalizeVapid(data.vapid),
    extras: extrasOf(data),
    briefingSeen: isoOrNull(data.briefingSeen),
  };
}

export function getState() { return state; }

// fn(state, { synced, remote }) — synced: 다른 기기와 공유되는 데이터를 이 기기에서 바꿈, remote: 다른 기기의 변경을 반영함
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function commit({ synced = true, remote = false } = {}) {
  if (storage) {
    try { storage.setItem(KEY, JSON.stringify(state)); } catch (err) { console.warn('저장 실패', err); }
  }
  listeners.forEach((fn) => fn(state, { synced, remote }));
}

export function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function tombstone(id, at = nowIso()) {
  state.deleted[id] = at;
}

// ───────── 할 일 ─────────

export function addTodo(fields) {
  const now = nowIso();
  const todo = {
    id: uid(), title: '', due: null, time: null, priority: 'medium', tags: [], notes: '', repeat: null,
    done: false, doneAt: null, createdAt: now, originalDue: null, postponed: 0, remind: null,
    ...fields,
    updatedAt: now,
  };
  todo.originalDue = todo.due;
  state.todos.push(todo);
  commit();
  return todo;
}

export function updateTodo(id, fields) {
  const t = state.todos.find((x) => x.id === id);
  if (!t) return null;
  Object.assign(t, fields, { updatedAt: nowIso() });
  commit();
  return t;
}

export function deleteTodo(id) {
  state.todos = state.todos.filter((x) => x.id !== id);
  tombstone(id);
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
  const months = repeat === 'yearly' ? 12 : 1;
  let next = addMonths(due || todayIso, months);
  while (diffDays(next, todayIso) <= 0) next = addMonths(next, months);
  return next;
}

// 완료 토글. 반복 할 일은 완료 시 다음 회차를 새로 만든다.
export function toggleTodo(id, now = new Date()) {
  const t = state.todos.find((x) => x.id === id);
  if (!t) return null;
  const at = now.toISOString();
  t.done = !t.done;
  t.doneAt = t.done ? at : null;
  t.updatedAt = at;
  let spawned = null;
  if (t.done && t.repeat) {
    const due = nextDue(t.due, t.repeat, toISODate(now));
    spawned = {
      ...t, id: uid(), done: false, doneAt: null, due, originalDue: due, postponed: 0,
      tags: [...t.tags], createdAt: at, updatedAt: at,
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
  t.updatedAt = nowIso();
  commit();
  return t;
}

// ───────── 일정 ─────────

export function addEvent(fields) {
  const now = nowIso();
  const ev = {
    id: uid(), title: '', date: today(), endDate: null, time: null, endTime: null, location: '', notes: '', remind: null,
    repeat: null, repeatUntil: null, exdates: [], createdAt: now,
    ...fields,
    updatedAt: now,
  };
  state.events.push(ev);
  commit();
  return ev;
}

export function updateEvent(id, fields) {
  const e = state.events.find((x) => x.id === id);
  if (!e) return null;
  Object.assign(e, fields, { updatedAt: nowIso() });
  commit();
  return e;
}

export function deleteEvent(id) {
  state.events = state.events.filter((x) => x.id !== id);
  tombstone(id);
  commit();
}

// ───────── 메모 ─────────

export function addMemo(fields) {
  const now = nowIso();
  const memo = { id: uid(), title: '', body: '', tags: [], pinned: false, createdAt: now, ...fields, updatedAt: now };
  state.memos.push(memo);
  commit();
  return memo;
}

export function updateMemo(id, fields) {
  const m = state.memos.find((x) => x.id === id);
  if (!m) return null;
  Object.assign(m, fields, { updatedAt: nowIso() });
  commit();
  return m;
}

export function deleteMemo(id) {
  state.memos = state.memos.filter((x) => x.id !== id);
  tombstone(id);
  commit();
}

// ───────── 설정·백업 (이 기기에만 적용) ─────────

export function setSettings(fields) {
  Object.assign(state.settings, fields);
  commit({ synced: false });
}

export function markBriefingSeen(iso) {
  if (state.briefingSeen === iso) return;
  state.briefingSeen = iso;
  commit({ synced: false });
}

// 백업 복원: 백업에 없는 항목은 삭제로 처리하고, 백업 항목은 지금 고친 것으로 본다.
// 동기화 중이면 다른 기기에도 그대로 반영된다.
export function replaceAll(data) {
  const incoming = normalize(data);
  const now = nowIso();
  const keep = new Set(COLLECTIONS.flatMap((c) => incoming[c].map((x) => x.id)));
  COLLECTIONS.forEach((c) => state[c].forEach((x) => { if (!keep.has(x.id)) tombstone(x.id, now); }));
  COLLECTIONS.forEach((c) => {
    state[c] = incoming[c].map((x) => ({ ...x, updatedAt: now }));
    state[c].forEach((x) => { delete state.deleted[x.id]; });
  });
  state.settings = incoming.settings;
  commit();
}

export function mergeTodos(todos) {
  const now = nowIso();
  todos.forEach((t) => {
    state.todos.push({
      id: uid(), title: '', due: null, time: null, priority: 'medium', tags: [], notes: '', repeat: null,
      done: false, doneAt: null, createdAt: now, postponed: 0, ...t, originalDue: t.due || null, updatedAt: now,
    });
  });
  commit();
}

// 모든 데이터 삭제. 동기화 중이면 다른 기기에서도 지워진다.
export function clearAll() {
  const now = nowIso();
  COLLECTIONS.forEach((c) => { state[c].forEach((x) => tombstone(x.id, now)); state[c] = []; });
  state.settings = defaultState().settings;
  state.briefingSeen = null;
  commit();
}

// ───────── 동기화용 스냅샷·병합 ─────────

export function setDevice(id, fields) {
  state.devices[id] = { label: '기기', push: null, vapidKey: null, ...state.devices[id], ...fields, updatedAt: nowIso() };
  commit();
  return state.devices[id];
}

export function setVapid(vapid) {
  state.vapid = { ...vapid, createdAt: vapid.createdAt || nowIso() };
  commit();
  return state.vapid;
}

// 키 순서와 무관하게 같은 내용이면 같은 문자열이 나온다.
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export function syncSnapshot(s = state) {
  return JSON.parse(JSON.stringify({
    ...(s.extras || {}),
    format: SYNC_FORMAT,
    todos: s.todos,
    events: s.events,
    memos: s.memos,
    deleted: s.deleted,
    devices: s.devices,
    vapid: s.vapid,
  }));
}

export function sameSnapshot(a, b) {
  return stableStringify(syncSnapshot(normalize(a))) === stableStringify(syncSnapshot(normalize(b)));
}

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return stableStringify(a) >= stableStringify(b) ? a : b;
}

const byCreated = (a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : (a.createdAt < b.createdAt ? -1 : 1));

// 두 기기의 데이터를 합친다. 순서와 상관없이 같은 결과가 나온다.
export function mergeSnapshots(rawA, rawB, now = new Date()) {
  const a = normalize(rawA);
  if (!rawB) return syncSnapshot(a);
  const b = normalize(rawB);

  const cutoff = new Date(now.getTime() - TOMBSTONE_DAYS * 86400000).toISOString();
  const deleted = {};
  [a.deleted, b.deleted].forEach((d) => Object.entries(d).forEach(([id, at]) => {
    if (!deleted[id] || at > deleted[id]) deleted[id] = at;
  }));

  const out = { deleted: {} };
  COLLECTIONS.forEach((c) => {
    const map = new Map();
    [...a[c], ...b[c]].forEach((x) => map.set(x.id, newer(map.get(x.id), x)));
    out[c] = [...map.values()].filter((x) => !(deleted[x.id] && deleted[x.id] >= x.updatedAt)).sort(byCreated);
  });
  Object.entries(deleted).forEach(([id, at]) => { if (at >= cutoff) out.deleted[id] = at; });

  out.devices = {};
  new Set([...Object.keys(a.devices), ...Object.keys(b.devices)]).forEach((id) => {
    out.devices[id] = newer(a.devices[id], b.devices[id]);
  });

  // 알림 키는 먼저 만든 쪽을 유지한다(구독이 키에 묶여 있으므로 바뀌면 안 된다).
  let vapid = a.vapid || b.vapid;
  if (a.vapid && b.vapid && a.vapid.publicKey !== b.vapid.publicKey) {
    vapid = a.vapid.createdAt === b.vapid.createdAt
      ? (a.vapid.publicKey < b.vapid.publicKey ? a.vapid : b.vapid)
      : (a.vapid.createdAt < b.vapid.createdAt ? a.vapid : b.vapid);
  }
  out.vapid = vapid;
  out.extras = { ...b.extras, ...a.extras };

  return syncSnapshot({ ...out });
}

// 원격 데이터를 이 기기에 반영한다. 그사이 이 기기에서 고친 내용은 병합으로 보존된다.
// 반환값: 이 기기의 데이터가 바뀌었는지
export function applySnapshot(snap) {
  const before = syncSnapshot();
  const merged = mergeSnapshots(before, snap);
  if (stableStringify(merged) === stableStringify(before)) return false;
  const n = normalize({ ...merged, settings: state.settings, briefingSeen: state.briefingSeen });
  n.extras = extrasOf(merged);
  state = n;
  commit({ synced: false, remote: true });
  return true;
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

export const isMultiDay = (e) => !!e.endDate && e.endDate > e.date;

// iso에서 n달 뒤의 같은 날짜. 그달에 그 날짜가 없으면(31일, 2월 29일) null
function sameDayMonthsLater(iso, n) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + n;
  const d = Number(iso.slice(8, 10));
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  if (d > new Date(ty, tm + 1, 0).getDate()) return null;
  return toISODate(new Date(ty, tm, d));
}

function nthStart(e, n) {
  if (e.repeat === 'daily') return addDays(e.date, n);
  if (e.repeat === 'weekly') return addDays(e.date, 7 * n);
  return sameDayMonthsLater(e.date, (e.repeat === 'yearly' ? 12 : 1) * n);
}

// 일정이 from~to 기간에 걸치는 회차들 [{ date, endDate }]. 반복이 없으면 많아야 하나.
export function occurrences(e, from, to) {
  const span = isMultiDay(e) ? diffDays(e.endDate, e.date) : 0;
  if (!e.repeat) {
    const end = addDays(e.date, span);
    return e.date <= to && end >= from ? [{ date: e.date, endDate: end }] : [];
  }
  const out = [];
  const exdates = new Set(e.exdates || []);
  // 기간 직전 회차부터 살펴본다
  const earliest = addDays(from, -span);
  let n = 0;
  if (earliest > e.date) {
    const gap = diffDays(earliest, e.date);
    const months = (Number(earliest.slice(0, 4)) - Number(e.date.slice(0, 4))) * 12 + Number(earliest.slice(5, 7)) - Number(e.date.slice(5, 7));
    n = Math.max(0, {
      daily: gap, weekly: Math.floor(gap / 7), monthly: months - 1, yearly: Math.floor(months / 12) - 1,
    }[e.repeat]);
  }
  for (let guard = 0; guard < 2000; guard += 1, n += 1) {
    const start = nthStart(e, n);
    if (start === null) continue; // 그달에 없는 날짜는 건너뛴다
    if (start > to || (e.repeatUntil && start > e.repeatUntil)) break;
    const end = addDays(start, span);
    if (end >= from && !exdates.has(start)) out.push({ date: start, endDate: end });
  }
  return out;
}

export function compareEvents(a, b) {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  return (a.time || '').localeCompare(b.time || '');
}

// from 이상 to 이하에 걸치는 일정(반복 일정은 회차마다 하나씩). seriesDate는 반복의 첫 날짜.
export function eventsBetween(s, from, to) {
  return s.events
    .flatMap((e) => occurrences(e, from, to).map((o) => ({ ...e, date: o.date, endDate: o.endDate, seriesDate: e.date, allDay: !e.time })))
    .sort(compareEvents);
}

export function eventsOn(s, iso) {
  return eventsBetween(s, iso, iso).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
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
    // 여러 날 일정은 첫날의 시작 시각에만 알린다
    if (!e.time || e.time < hm || e.date !== t) return;
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
