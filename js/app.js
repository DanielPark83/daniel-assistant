// Daniel's 개인 비서 — 화면 렌더링과 사용자 상호작용

import * as store from './store.js';
import * as sync from './sync.js';
import * as push from './push.js';
import { qrSvg, startScanner } from './qr.js';
import { REMIND_OPTIONS, remindLabel, createLocalReminders } from './reminders.js';
import { parseQuickInput } from './nlp.js';
import { buildBriefing, greeting } from './briefing.js';
import { parseMarkdownTasks, exportMarkdown } from './markdown.js';
import {
  today, addDays, addMonths, diffDays, weekdayOf, startOfWeek, endOfMonth,
  formatLong, formatShort, formatRelative, formatTime, WEEKDAYS,
} from './dates.js';

// 이 스크립트 주소의 ?v= 값이 지금 실행 중인 앱 버전이다(index.html 참고).
const APP_VERSION = new URL(import.meta.url).searchParams.get('v') || 'dev';

const TABS = ['home', 'todos', 'calendar', 'memos', 'briefing'];
const PRIORITY_LABEL = { high: '높음', medium: '보통', low: '낮음' };
const REPEAT_LABEL = { daily: '매일', weekly: '매주', monthly: '매월', yearly: '매년' };

const view = document.getElementById('view');
const sheet = document.getElementById('sheet');
const toastEl = document.getElementById('toast');

const ui = {
  syncBusy: false,
  pushBusy: false,
  repoChoices: null, // 토큰으로 쓸 수 있는 저장소가 여러 개일 때 고르는 목록
  pendingToken: '',
  showQr: false,
  stopScanner: null,
  tab: 'home',
  quickMode: 'todo',
  todoScope: 'open',
  todoPriority: '',
  todoTag: '',
  calMonth: today().slice(0, 7),
  calDay: today(),
  memoQuery: '',
  memoTag: '',
};

// ───────── 공통 헬퍼 ─────────

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  pin: '<path d="M12 17v5M5 17h14l-2-5V6a2 2 0 0 0 1-1.7V4a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v.3A2 2 0 0 0 7 6v6z"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4h-4"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
};
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  // 열려 있는 시트 위에 보이도록 최상위 레이어에 다시 올린다 (popover 지원 브라우저).
  if (toastEl.showPopover) {
    try {
      if (toastEl.matches(':popover-open')) toastEl.hidePopover();
      toastEl.showPopover();
    } catch { /* 무시 */ }
  }
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    if (toastEl.hidePopover) { try { toastEl.hidePopover(); } catch { /* 무시 */ } }
  }, 2600);
}

const parseTags = (str) => [...new Set(String(str || '').split(/[\s,]+/).map((t) => t.replace(/^#+/, '')).filter(Boolean))];

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function highlight(text, words) {
  if (!words.length) return esc(text);
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return String(text).split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

// ───────── 조각 템플릿 ─────────

function dueChip(todo, t) {
  if (!todo.due) return '';
  const diff = diffDays(todo.due, t);
  const overdue = !todo.done && diff < 0;
  const label = overdue ? `${-diff}일 지연` : formatRelative(todo.due, t);
  const time = todo.time ? ` ${formatTime(todo.time)}` : '';
  return `<span class="chip ${overdue ? 'chip-critical' : diff === 0 && !todo.done ? 'chip-accent' : ''}">${icon(overdue ? 'alert' : 'clock')}${esc(label + time)}</span>`;
}

function todoRow(todo, t, { postpone = false } = {}) {
  const chips = [
    dueChip(todo, t),
    todo.priority === 'high' ? `<span class="chip chip-warning">${icon('flag')}중요</span>` : '',
    todo.priority === 'low' ? '<span class="chip">낮음</span>' : '',
    todo.repeat ? `<span class="chip">${icon('repeat')}${REPEAT_LABEL[todo.repeat]}</span>` : '',
    todo.postponed ? `<span class="chip">${todo.postponed}번 미룸</span>` : '',
    todo.remind != null && !todo.done ? `<span class="chip">${icon('bell')}${esc(remindLabel(todo.remind))}</span>` : '',
    ...todo.tags.map((tag) => `<span class="chip chip-tag">#${esc(tag)}</span>`),
  ].join('');
  return `
    <li class="row todo ${todo.done ? 'is-done' : ''}">
      <button class="check" type="button" data-action="toggle-todo" data-id="${esc(todo.id)}"
        aria-pressed="${todo.done}" aria-label="${todo.done ? '완료 취소' : '완료'}: ${esc(todo.title)}">${icon('check')}</button>
      <div class="row-main">
        <button class="row-body" type="button" data-action="edit-todo" data-id="${esc(todo.id)}">
          <span class="row-title">${esc(todo.title)}</span>
          ${chips ? `<span class="chips">${chips}</span>` : ''}
        </button>
        ${postpone ? `
          <div class="row-actions">
            <button class="btn btn-small" type="button" data-action="postpone" data-id="${esc(todo.id)}" data-days="0">오늘로</button>
            <button class="btn btn-small" type="button" data-action="postpone" data-id="${esc(todo.id)}" data-days="1">내일로</button>
            <button class="btn btn-small" type="button" data-action="postpone" data-id="${esc(todo.id)}" data-days="7">다음 주로</button>
          </div>` : ''}
      </div>
    </li>`;
}

// day: 이 줄을 보여 주는 날. 여러 날 일정은 첫날에 시작 시각, 마지막 날에 끝 시각을 보여 준다.
function eventRow(ev, day = ev.date) {
  const multi = store.isMultiDay(ev);
  let time = !ev.time ? '종일' : formatTime(ev.time);
  if (multi && day > ev.date) time = day === ev.endDate && ev.endTime ? `~${formatTime(ev.endTime)}` : '종일';
  const sub = [
    multi ? `${formatShort(ev.date)} ~ ${formatShort(ev.endDate)} (${diffDays(day, ev.date) + 1}/${diffDays(ev.endDate, ev.date) + 1}일)` : '',
    !multi && ev.endTime && ev.time ? `~ ${formatTime(ev.endTime)}` : '',
    ev.location ? ev.location : '',
    ev.repeat ? `${REPEAT_LABEL[ev.repeat]} 반복` : '',
    ev.remind != null ? `알림 ${remindLabel(ev.remind)}` : '',
  ].filter(Boolean).join(' · ');
  return `
    <li class="row event">
      <button class="row-body event-body" type="button" data-action="open-event" data-id="${esc(ev.id)}" data-date="${esc(ev.date)}">
        <span class="event-time">${esc(time)}</span>
        <span class="event-text">
          <span class="row-title">${esc(ev.title)}</span>
          ${sub ? `<span class="row-sub">${esc(sub)}</span>` : ''}
        </span>
      </button>
    </li>`;
}

const empty = (text) => `<p class="empty">${esc(text)}</p>`;

function quickAdd({ modes = true } = {}) {
  const mode = modes ? ui.quickMode : 'todo';
  const placeholder = {
    todo: '예: 내일 오후 3시 보고서 제출 !중요 #업무',
    event: '예: 금요일 저녁 7시 가족 식사 / 20~22일 부산 출장',
    memo: '예: 회의 아이디어 — 온보딩 개선 #기획',
  }[mode];
  return `
    <form class="card quick" data-form="quick" data-mode="${mode}" autocomplete="off">
      ${modes ? `
        <div class="seg" role="group" aria-label="추가할 항목 종류">
          ${[['todo', '할 일'], ['event', '일정'], ['memo', '메모']].map(([k, label]) => `
            <button type="button" class="seg-btn ${mode === k ? 'is-on' : ''}" data-action="quick-mode" data-mode="${k}" aria-pressed="${mode === k}">${label}</button>`).join('')}
        </div>` : ''}
      <div class="quick-row">
        <input class="input" name="text" type="text" placeholder="${esc(placeholder)}" aria-label="빠른 입력" enterkeyhint="done">
        <button class="btn btn-primary" type="submit" aria-label="추가">${icon('plus')}</button>
      </div>
      <div class="quick-preview" aria-live="polite"></div>
    </form>`;
}

function quickPreview(form) {
  const mode = form.dataset.mode;
  const text = form.elements.text.value;
  const box = form.querySelector('.quick-preview');
  if (!text.trim() || mode === 'memo') { box.innerHTML = ''; return; }
  const p = parseQuickInput(text);
  const t = today();
  const chips = [];
  const due = p.due || (mode === 'event' ? t : null);
  if (due && p.endDate && mode === 'event') {
    chips.push(`<span class="chip chip-accent">${icon('calendar')}${esc(`${formatShort(due)} ~ ${formatShort(p.endDate)} · ${diffDays(p.endDate, due) + 1}일${p.time ? ` · ${formatTime(p.time)}` : ''}`)}</span>`);
  } else if (due) {
    const d = mode === 'todo' && p.endDate ? p.endDate : due;
    chips.push(`<span class="chip chip-accent">${icon('calendar')}${esc(`${formatRelative(d, t)}${p.time ? ` ${formatTime(p.time)}` : ''}`)}</span>`);
  }
  if (p.remind != null && mode !== 'memo') chips.push(`<span class="chip">${icon('bell')}${esc(remindLabel(p.remind))}</span>`);
  if (mode === 'event' && p.repeat) chips.push(`<span class="chip">${icon('repeat')}${REPEAT_LABEL[p.repeat]}</span>`);
  if (mode === 'todo') {
    if (p.priority === 'high') chips.push(`<span class="chip chip-warning">${icon('flag')}중요</span>`);
    if (p.priority === 'low') chips.push('<span class="chip">낮음</span>');
    if (p.repeat) chips.push(`<span class="chip">${icon('repeat')}${REPEAT_LABEL[p.repeat]}</span>`);
    p.tags.forEach((tag) => chips.push(`<span class="chip chip-tag">#${esc(tag)}</span>`));
  }
  box.innerHTML = chips.length ? `<span class="quick-title">${esc(p.title || '(제목 없음)')}</span>${chips.join('')}` : '';
}

// ───────── 오늘(대시보드) ─────────

function viewHome() {
  const s = store.getState();
  const now = new Date();
  const t = today(now);
  const brief = buildBriefing(s, now);
  const todayOpen = store.todosDueOn(s, t);
  const todayDone = store.todosDoneOn(s, t);
  const overdue = store.overdueTodos(s, t);
  const alertList = store.alerts(s, now);
  const todayEvents = store.eventsOn(s, t);
  const weekEnd = addDays(t, 6); // 오늘부터 7일
  const weekEvents = store.eventsBetween(s, t, weekEnd);
  const weekTodos = s.todos.filter((x) => !x.done && x.due && x.due >= t && x.due <= weekEnd).sort(store.compareTodos);
  const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const nextEvent = todayEvents.find((e) => e.time && e.date === t && e.time >= nowHM);

  // 예정 할 일 및 일정: 오늘부터 7일, 날짜별로 묶는다(이미 시작한 여러 날 일정은 오늘에)
  const groups = new Map();
  const groupOf = (day) => {
    if (!groups.has(day)) groups.set(day, { events: [], todos: [] });
    return groups.get(day);
  };
  weekEvents.forEach((e) => groupOf(e.date < t ? t : e.date).events.push(e));
  weekTodos.forEach((x) => groupOf(x.due).todos.push(x));
  const dayGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const weekCount = weekEvents.length + weekTodos.length;

  const briefingCard = `
    <section class="card briefing-card ${s.briefingSeen === t ? '' : 'is-new'}">
      <div class="card-head">
        <h2>오늘의 브리핑</h2>
        ${s.briefingSeen === t ? '' : '<span class="badge">새 브리핑</span>'}
      </div>
      <p class="briefing-headline">${esc(brief.headline)}</p>
      <a class="btn btn-ghost" href="#briefing">브리핑 전체 보기</a>
    </section>`;

  return `
    <section class="hero">
      <p class="hero-date">${esc(formatLong(t))}</p>
      <h2 class="hero-greeting">${esc(greeting(now))}, ${esc(s.settings.name)}</h2>
    </section>

    <section class="tiles" aria-label="오늘 요약">
      <button class="tile" type="button" data-action="goto-todos-today">
        <span class="tile-label">오늘 할 일</span>
        <span class="tile-value">${todayOpen.length}</span>
        <span class="tile-sub">${todayDone.length ? `${todayDone.length}건 완료` : 'To-do'}</span>
      </button>
      <a class="tile" href="#calendar">
        <span class="tile-label">예정 일정</span>
        <span class="tile-value">${todayEvents.length}</span>
        <span class="tile-sub">${nextEvent ? `다음 ${esc(formatTime(nextEvent.time))}` : 'Calendar'}</span>
      </a>
      <button class="tile ${alertList.length ? 'tile-alert' : ''}" type="button" data-action="scroll-alerts">
        <span class="tile-label">${alertList.length ? icon('alert') : ''}중요 알림</span>
        <span class="tile-value">${alertList.length}</span>
        <span class="tile-sub">${overdue.length ? `지연 ${overdue.length}건` : alertList.length ? '확인 필요' : '이상 없음'}</span>
      </button>
    </section>

    ${quickAdd()}

    ${s.briefingSeen === t ? '' : briefingCard}

    <section class="card" id="alerts">
      <div class="card-head"><h2>중요 알림</h2></div>
      ${alertList.length ? `<ul class="list">${alertList.map((a) => `
        <li class="row alert alert-${a.level}">
          <button class="row-body alert-body" type="button" data-action="${a.kind === 'todo' ? 'edit-todo' : 'open-event'}" data-id="${esc(a.id)}">
            <span class="alert-icon">${icon(a.kind === 'event' ? 'clock' : 'alert')}</span>
            <span class="event-text">
              <span class="row-title">${esc(a.text)}</span>
              <span class="row-sub">${esc(a.detail)}</span>
            </span>
          </button>
        </li>`).join('')}</ul>` : empty('지금 확인할 알림이 없습니다.')}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>오늘 할 일</h2>
        <span class="card-meta">${todayDone.length}/${todayOpen.length + todayDone.length} 완료</span>
      </div>
      ${todayOpen.length + todayDone.length
    ? `<ul class="list">${[...todayOpen, ...todayDone].map((x) => todoRow(x, t)).join('')}</ul>`
    : empty('오늘 마감인 할 일이 없습니다. 위 입력창에 "오늘 …" 이라고 적어 보세요.')}
    </section>

    ${overdue.length ? `
      <section class="card">
        <div class="card-head">
          <h2>미완료 항목 추적</h2>
          <span class="card-meta">${overdue.length}건 이월</span>
        </div>
        <ul class="list">${overdue.map((x) => todoRow(x, t, { postpone: true })).join('')}</ul>
      </section>` : ''}

    <section class="card">
      <div class="card-head">
        <h2>예정 할 일 및 일정</h2>
        <span class="card-meta">오늘부터 7일 · ${weekCount}건</span>
      </div>
      ${dayGroups.length ? dayGroups.map(([day, g]) => `
        <h3 class="group-title">${esc(formatRelative(day, t))}${diffDays(day, t) > 2 ? '' : ` · ${esc(formatShort(day))}`}</h3>
        <ul class="list">
          ${g.events.map((e) => eventRow(e, day)).join('')}
          ${g.todos.map((x) => todoRow(x, t)).join('')}
        </ul>`).join('') : empty('앞으로 7일간 예정된 할 일과 일정이 없습니다.')}
      <a class="card-link" href="#calendar">캘린더에서 보기</a>
    </section>

    ${s.briefingSeen === t ? briefingCard : ''}
  `;
}

// ───────── 할 일 ─────────

function viewTodos() {
  const s = store.getState();
  const t = today();
  const weekEnd = addDays(startOfWeek(t), 6);
  const open = s.todos.filter((x) => !x.done);
  const scopes = {
    open: ['진행 중', open],
    today: ['오늘', open.filter((x) => x.due === t)],
    week: ['이번 주', open.filter((x) => x.due && x.due >= t && x.due <= weekEnd)],
    overdue: ['지연', open.filter((x) => x.due && x.due < t)],
    nodate: ['날짜 없음', open.filter((x) => !x.due)],
    done: ['완료', s.todos.filter((x) => x.done)],
  };
  const tags = store.allTags(s.todos);
  if (ui.todoTag && !tags.includes(ui.todoTag)) ui.todoTag = '';

  const list = scopes[ui.todoScope][1]
    .filter((x) => !ui.todoPriority || x.priority === ui.todoPriority)
    .filter((x) => !ui.todoTag || x.tags.includes(ui.todoTag))
    .sort(store.compareTodos);

  let body;
  if (!list.length) {
    body = empty(s.todos.length ? '조건에 맞는 할 일이 없습니다.' : '아직 할 일이 없습니다. 위 입력창에 자연스럽게 적어 보세요.');
  } else if (ui.todoScope === 'open') {
    const buckets = [
      ['지연', (x) => x.due && x.due < t],
      ['오늘', (x) => x.due === t],
      ['내일', (x) => x.due === addDays(t, 1)],
      ['이번 주', (x) => x.due && x.due > addDays(t, 1) && x.due <= weekEnd],
      ['이후', (x) => x.due && x.due > weekEnd && x.due > addDays(t, 1)],
      ['날짜 없음', (x) => !x.due],
    ];
    body = buckets.map(([title, test]) => {
      const items = list.filter(test);
      return items.length ? `
        <h3 class="group-title">${title} <span class="count">${items.length}</span></h3>
        <ul class="list">${items.map((x) => todoRow(x, t, { postpone: title === '지연' })).join('')}</ul>` : '';
    }).join('');
  } else {
    body = `<ul class="list">${list.map((x) => todoRow(x, t, { postpone: ui.todoScope === 'overdue' })).join('')}</ul>`;
  }

  return `
    <h2 class="page-title">할 일</h2>
    ${quickAdd({ modes: false })}
    <div class="filters">
      <div class="chip-row" role="group" aria-label="범위">
        ${Object.entries(scopes).map(([k, [label, items]]) => `
          <button type="button" class="filter ${ui.todoScope === k ? 'is-on' : ''}" data-action="todo-scope" data-value="${k}" aria-pressed="${ui.todoScope === k}">${label} <span class="count">${items.length}</span></button>`).join('')}
      </div>
      <div class="chip-row" role="group" aria-label="중요도와 태그">
        ${[['', '모든 중요도'], ['high', '높음'], ['medium', '보통'], ['low', '낮음']].map(([k, label]) => `
          <button type="button" class="filter ${ui.todoPriority === k ? 'is-on' : ''}" data-action="todo-priority" data-value="${k}" aria-pressed="${ui.todoPriority === k}">${label}</button>`).join('')}
        ${tags.map((tag) => `
          <button type="button" class="filter ${ui.todoTag === tag ? 'is-on' : ''}" data-action="todo-tag" data-value="${esc(tag)}" aria-pressed="${ui.todoTag === tag}">#${esc(tag)}</button>`).join('')}
      </div>
    </div>
    <section class="card">${body}</section>
  `;
}

// ───────── 캘린더 ─────────

function viewCalendar() {
  const s = store.getState();
  const t = today();
  const first = `${ui.calMonth}-01`;
  const last = endOfMonth(first);
  const gridStart = addDays(first, -weekdayOf(first));
  const weeks = Math.ceil((weekdayOf(first) + Number(last.slice(8))) / 7);
  const gridEnd = addDays(gridStart, weeks * 7 - 1);

  const eventDays = new Map();
  store.eventsBetween(s, gridStart, gridEnd).forEach((e) => {
    for (let d = e.date < gridStart ? gridStart : e.date; d <= e.endDate && d <= gridEnd; d = addDays(d, 1)) {
      eventDays.set(d, (eventDays.get(d) || 0) + 1);
    }
  });
  const todoDays = new Map();
  s.todos.filter((x) => !x.done && x.due).forEach((x) => todoDays.set(x.due, (todoDays.get(x.due) || 0) + 1));

  const cells = [];
  for (let i = 0; i < weeks * 7; i += 1) {
    const d = addDays(gridStart, i);
    const ev = eventDays.get(d) || 0;
    const td = todoDays.get(d) || 0;
    const label = `${formatLong(d)}${ev ? `, 일정 ${ev}건` : ''}${td ? `, 할 일 ${td}건` : ''}`;
    cells.push(`
      <button type="button" class="day ${d.slice(0, 7) === ui.calMonth ? '' : 'is-out'} ${d === t ? 'is-today' : ''} ${d === ui.calDay ? 'is-selected' : ''} ${i % 7 === 0 ? 'is-sun' : ''}"
        data-action="cal-day" data-date="${d}" aria-label="${esc(label)}" aria-pressed="${d === ui.calDay}">
        <span class="day-num">${Number(d.slice(8))}</span>
        <span class="day-marks">${ev ? '<i class="mark mark-event"></i>' : ''}${td ? '<i class="mark mark-todo"></i>' : ''}</span>
      </button>`);
  }

  const dayEvents = store.eventsOn(s, ui.calDay);
  const dayTodos = s.todos.filter((x) => x.due === ui.calDay).sort(store.compareTodos);
  const [y, m] = ui.calMonth.split('-').map(Number);

  return `
    <h2 class="page-title">캘린더</h2>
    <section class="card cal">
      <div class="cal-head">
        <button class="icon-btn" type="button" data-action="cal-move" data-step="-1" aria-label="이전 달">${icon('left')}</button>
        <h3 class="cal-title">${y}년 ${m}월</h3>
        <button class="icon-btn" type="button" data-action="cal-move" data-step="1" aria-label="다음 달">${icon('right')}</button>
        <button class="btn btn-small" type="button" data-action="cal-today">오늘</button>
      </div>
      <div class="cal-grid cal-week" aria-hidden="true">${WEEKDAYS.map((w, i) => `<span class="${i === 0 ? 'is-sun' : ''}">${w}</span>`).join('')}</div>
      <div class="cal-grid">${cells.join('')}</div>
      <p class="legend"><i class="mark mark-event"></i>일정 <i class="mark mark-todo"></i>할 일 마감</p>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>${esc(formatLong(ui.calDay))}</h2>
        <button class="btn btn-small" type="button" data-action="new-event">${icon('plus')}일정</button>
      </div>
      ${dayEvents.length ? `<ul class="list">${dayEvents.map((e) => eventRow(e, ui.calDay)).join('')}</ul>` : empty('일정이 없습니다.')}
      ${dayTodos.length ? `<h3 class="group-title">할 일 마감</h3><ul class="list">${dayTodos.map((x) => todoRow(x, t)).join('')}</ul>` : ''}
    </section>
  `;
}

// ───────── 메모 ─────────

function memoListHtml() {
  const s = store.getState();
  const words = ui.memoQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const memos = store.searchMemos(s, ui.memoQuery, ui.memoTag);
  if (!memos.length) {
    return empty(s.memos.length ? '검색 결과가 없습니다.' : '아직 메모가 없습니다. 오른쪽 위 버튼으로 첫 메모를 남겨 보세요.');
  }
  return `<ul class="list memo-list">${memos.map((m) => {
    const body = m.body.replace(/\s+/g, ' ').trim();
    let snippet = body.slice(0, 100);
    if (words.length) {
      const idx = body.toLowerCase().indexOf(words[0]);
      if (idx > 40) snippet = `…${body.slice(idx - 30, idx + 70)}`;
    }
    return `
      <li class="row memo">
        <button class="row-body" type="button" data-action="edit-memo" data-id="${esc(m.id)}">
          <span class="row-title">${m.pinned ? `<span class="pin" aria-label="고정됨">${icon('pin')}</span>` : ''}${highlight(m.title || '(제목 없음)', words)}</span>
          ${snippet ? `<span class="memo-snippet">${highlight(snippet, words)}</span>` : ''}
          <span class="chips">
            ${m.tags.map((tag) => `<span class="chip chip-tag">#${highlight(tag, words)}</span>`).join('')}
            <span class="chip">${esc(formatRelative(today(new Date(m.updatedAt))))}</span>
          </span>
        </button>
      </li>`;
  }).join('')}</ul><p class="hint">${memos.length}개의 메모</p>`;
}

function viewMemos() {
  const s = store.getState();
  const tags = store.allTags(s.memos);
  if (ui.memoTag && !tags.includes(ui.memoTag)) ui.memoTag = '';
  return `
    <div class="page-head">
      <h2 class="page-title">메모</h2>
      <button class="btn btn-primary" type="button" data-action="new-memo">${icon('plus')}새 메모</button>
    </div>
    <label class="search">
      ${icon('search')}
      <input class="input" id="memo-search" type="search" placeholder="제목·내용·태그 검색" value="${esc(ui.memoQuery)}" aria-label="메모 검색" autocomplete="off">
    </label>
    ${tags.length ? `
      <div class="filters"><div class="chip-row" role="group" aria-label="태그">
        <button type="button" class="filter ${ui.memoTag ? '' : 'is-on'}" data-action="memo-tag" data-value="" aria-pressed="${!ui.memoTag}">전체</button>
        ${tags.map((tag) => `<button type="button" class="filter ${ui.memoTag === tag ? 'is-on' : ''}" data-action="memo-tag" data-value="${esc(tag)}" aria-pressed="${ui.memoTag === tag}">#${esc(tag)}</button>`).join('')}
      </div></div>` : ''}
    <section class="card" id="memo-results">${memoListHtml()}</section>
  `;
}

// ───────── 브리핑 ─────────

function viewBriefing() {
  const s = store.getState();
  const brief = buildBriefing(s);
  const archive = s.memos.filter((m) => m.tags.includes(store.BRIEFING_TAG)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return `
    <h2 class="page-title">브리핑</h2>
    <section class="card">
      <div class="card-head">
        <h2>${esc(formatLong(brief.date))}</h2>
        <button class="btn btn-small" type="button" data-action="copy-briefing">${icon('copy')}복사</button>
      </div>
      <p class="briefing-headline">${esc(brief.headline)}</p>
      ${brief.sections.map((sec) => `
        <h3 class="group-title">${esc(sec.title)}</h3>
        ${sec.items.length
    ? `<ul class="bullets">${sec.items.map((i) => `<li>${sec.memoId ? `<button class="link" type="button" data-action="edit-memo" data-id="${esc(sec.memoId)}">${esc(i)}</button>` : esc(i)}</li>`).join('')}${sec.more ? `<li class="muted">외 ${sec.more}건</li>` : ''}</ul>`
    : `<p class="empty">${esc(sec.empty)}</p>`}`).join('')}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>기술 브리핑 보관함</h2>
        <button class="btn btn-small" type="button" data-action="new-briefing">${icon('plus')}추가</button>
      </div>
      ${archive.length ? `<ul class="list">${archive.map((m) => `
        <li class="row memo">
          <button class="row-body" type="button" data-action="edit-memo" data-id="${esc(m.id)}">
            <span class="row-title">${esc(m.title || '(제목 없음)')}</span>
            <span class="memo-snippet">${esc(m.body.replace(/\s+/g, ' ').trim().slice(0, 100))}</span>
            <span class="chips"><span class="chip">${esc(formatShort(today(new Date(m.updatedAt))))}</span></span>
          </button>
        </li>`).join('')}</ul>`
    : empty('정기 기술 브리핑을 받아 보면 여기에 붙여 넣어 보관하세요. #브리핑 태그가 붙은 메모가 이곳에 모입니다.')}
    </section>
  `;
}

// ───────── 렌더 ─────────

function renderSyncIndicator() {
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  const st = sync.getStatus();
  el.hidden = st.state === 'off';
  el.dataset.state = st.state;
  const label = { idle: '동기화됨', syncing: '동기화 중', error: `동기화 오류: ${st.error || ''}`, offline: '오프라인' }[st.state] || '';
  el.setAttribute('aria-label', label);
  el.title = label;
}

const VIEWS = { home: viewHome, todos: viewTodos, calendar: viewCalendar, memos: viewMemos, briefing: viewBriefing };

function render() {
  pendingRender = false;
  const s = store.getState();
  // 빠른 입력창에 쓰던 글과 커서 위치는 다시 그려도 유지한다
  const q = view.querySelector('[data-form="quick"] input');
  const keep = q && q.value ? { value: q.value, focused: document.activeElement === q, start: q.selectionStart, end: q.selectionEnd } : null;
  view.innerHTML = VIEWS[ui.tab]();
  if (keep) {
    const n = view.querySelector('[data-form="quick"] input');
    if (n) {
      n.value = keep.value;
      quickPreview(n.form);
      if (keep.focused) {
        n.focus();
        try { n.setSelectionRange(keep.start, keep.end); } catch { /* 무시 */ }
      }
    }
  }
  document.querySelectorAll('.tab').forEach((el) => {
    const on = el.dataset.tab === ui.tab;
    el.classList.toggle('is-on', on);
    if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  document.querySelector('.tab-dot').hidden = s.briefingSeen === today();
  const theme = s.settings.theme;
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

// 연결 링크(#connect=…)로 열렸으면 주소에서 토큰을 지우고 연결을 묻는다
function takeConnectHash() {
  if (!location.hash.startsWith('#connect=')) return false;
  const payload = location.hash;
  history.replaceState(null, '', `${location.pathname}${location.search}#home`);
  setTimeout(() => connectFromPayload(payload), 300);
  return true;
}

function route() {
  takeConnectHash();
  const tab = location.hash.slice(1);
  ui.tab = TABS.includes(tab) ? tab : 'home';
  if (ui.tab === 'briefing') store.markBriefingSeen(today());
  render();
  window.scrollTo(0, 0);
}

// ───────── 시트(대화상자) ─────────

function openSheet(html) {
  sheet.innerHTML = html;
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
}

function closeSheet() {
  if (sheet.open) sheet.close();
  sheet.innerHTML = '';
}

const sheetHead = (title) => `
  <div class="sheet-head">
    <h2>${esc(title)}</h2>
    <button class="icon-btn" type="button" data-action="close-sheet" aria-label="닫기">${icon('x')}</button>
  </div>`;

// 알람 선택 칸. 시간이 없는 할 일·종일 일정은 그날 오전 9시를 기준으로 알린다.
function remindFieldHtml(value) {
  const v = value == null ? '' : String(value);
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  let note;
  if (perm === 'granted' && push.isEnabledHere()) note = '앱이 꺼져 있어도 이 기기로 알림이 옵니다.';
  else if (perm === 'granted') note = '지금은 앱이 켜져 있을 때만 울립니다. 앱이 꺼져 있어도 받으려면 설정 → 알림에서 「이 기기에서 알림 받기」를 눌러 주세요.';
  else note = '이 기기의 알림 권한이 꺼져 있어 앱 화면 안에서만 알려 드립니다. 설정 → 알림에서 「이 기기에서 알림 받기」를 눌러 주세요.';
  return `
    <label class="field"><span>알람</span>
      <select class="input" name="remind">
        ${REMIND_OPTIONS.map(([m, label]) => `<option value="${m == null ? '' : m}" ${String(m == null ? '' : m) === v ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </label>
    <p class="hint">시간이 없으면 그날 오전 9시를 기준으로 합니다. ${note}</p>`;
}

function todoSheet(todo) {
  const t = todo || { title: '', due: '', time: '', priority: 'medium', tags: [], notes: '', repeat: '' };
  const history = todo && todo.postponed
    ? `<p class="hint">원래 마감 ${esc(todo.originalDue ? formatShort(todo.originalDue) : '없음')} · ${todo.postponed}번 미룸</p>` : '';
  openSheet(`
    ${sheetHead(todo ? '할 일 수정' : '새 할 일')}
    <form class="form" data-form="todo" data-id="${esc(todo ? todo.id : '')}">
      <label class="field"><span>제목</span><input class="input" name="title" required value="${esc(t.title)}"></label>
      <div class="field-row">
        <label class="field"><span>마감일</span><input class="input" name="due" type="date" value="${esc(t.due || '')}"></label>
        <label class="field"><span>시간</span><input class="input" name="time" type="time" value="${esc(t.time || '')}"></label>
      </div>
      <fieldset class="field">
        <legend>중요도</legend>
        <div class="seg">
          ${['high', 'medium', 'low'].map((p) => `
            <label class="seg-btn"><input type="radio" name="priority" value="${p}" ${t.priority === p ? 'checked' : ''}><span>${PRIORITY_LABEL[p]}</span></label>`).join('')}
        </div>
      </fieldset>
      ${remindFieldHtml(t.remind)}
      <label class="field"><span>반복</span>
        <select class="input" name="repeat">
          <option value="">반복 없음</option>
          ${Object.entries(REPEAT_LABEL).map(([k, label]) => `<option value="${k}" ${t.repeat === k ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>태그</span><input class="input" name="tags" placeholder="업무 개인 (띄어쓰기로 구분)" value="${esc(t.tags.join(' '))}"></label>
      <label class="field"><span>메모</span><textarea class="input" name="notes" rows="3">${esc(t.notes)}</textarea></label>
      ${history}
      <div class="form-actions">
        ${todo ? '<button class="btn btn-danger" type="button" data-action="delete-todo">삭제</button>' : ''}
        <span class="spacer"></span>
        <button class="btn" type="button" data-action="close-sheet">취소</button>
        <button class="btn btn-primary" type="submit">저장</button>
      </div>
    </form>`);
}

// occurrence: 반복 일정에서 누른 회차의 날짜(그 날만 삭제할 때 쓴다)
function eventSheet(ev, date, occurrence) {
  const e = ev || { title: '', date: date || ui.calDay, endDate: '', time: '', endTime: '', location: '', notes: '', repeat: null, repeatUntil: null };
  const series = ev && ev.repeat;
  openSheet(`
    ${sheetHead(ev ? (series ? '반복 일정 수정' : '일정 수정') : '새 일정')}
    <form class="form" data-form="event" data-id="${esc(ev ? ev.id : '')}" data-occurrence="${esc(series && occurrence ? occurrence : '')}">
      ${series ? `<p class="hint">반복 일정은 고치면 모든 회차에 함께 적용됩니다. 첫 일정: ${esc(formatShort(e.date))}${occurrence && occurrence !== e.date ? ` · 지금 연 날짜: ${esc(formatShort(occurrence))}` : ''}</p>` : ''}
      <label class="field"><span>제목</span><input class="input" name="title" required value="${esc(e.title)}"></label>
      <div class="field-row">
        <label class="field"><span>시작일</span><input class="input" name="date" type="date" required value="${esc(e.date)}"></label>
        <label class="field"><span>종료일 <small>(여러 날일 때)</small></span><input class="input" name="endDate" type="date" value="${esc(e.endDate || '')}" min="${esc(e.date)}"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>시작 시간</span><input class="input" name="time" type="time" value="${esc(e.time || '')}"></label>
        <label class="field"><span>종료 시간</span><input class="input" name="endTime" type="time" value="${esc(e.endTime || '')}"></label>
      </div>
      <p class="hint">시간을 비우면 종일 일정입니다. 여러 날 일정의 종료 시간은 마지막 날의 시각입니다.</p>
      ${remindFieldHtml(e.remind)}
      <div class="field-row">
        <label class="field"><span>반복</span>
          <select class="input" name="repeat">
            <option value="">반복 없음</option>
            ${Object.entries(REPEAT_LABEL).map(([k, label]) => `<option value="${k}" ${e.repeat === k ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>반복 끝 <small>(비우면 계속)</small></span>
          <input class="input" name="repeatUntil" type="date" value="${esc(e.repeatUntil || '')}" min="${esc(e.date)}">
        </label>
      </div>
      <p class="hint">매월 31일처럼 그달에 없는 날짜는 건너뜁니다.${e.exdates && e.exdates.length ? ` 건너뛴 날짜 ${e.exdates.length}개` : ''}</p>
      <label class="field"><span>장소</span><input class="input" name="location" value="${esc(e.location)}"></label>
      <label class="field"><span>메모</span><textarea class="input" name="notes" rows="3">${esc(e.notes)}</textarea></label>
      <div class="form-actions">
        ${ev ? `<button class="btn btn-danger" type="button" data-action="delete-event">${series ? '전체 삭제' : '삭제'}</button>` : ''}
        ${series && occurrence ? '<button class="btn btn-danger" type="button" data-action="skip-occurrence">이 날만 삭제</button>' : ''}
        <span class="spacer"></span>
        <button class="btn" type="button" data-action="close-sheet">취소</button>
        <button class="btn btn-primary" type="submit">저장</button>
      </div>
    </form>`);
}

function memoSheet(memo, preset) {
  const m = memo || { title: '', body: '', tags: [], pinned: false, ...preset };
  openSheet(`
    ${sheetHead(memo ? '메모 수정' : '새 메모')}
    <form class="form" data-form="memo" data-id="${esc(memo ? memo.id : '')}">
      <label class="field"><span>제목</span><input class="input" name="title" value="${esc(m.title)}"></label>
      <label class="field"><span>내용</span><textarea class="input" name="body" rows="9">${esc(m.body)}</textarea></label>
      <label class="field"><span>태그</span><input class="input" name="tags" placeholder="기획 브리핑 (띄어쓰기로 구분)" value="${esc(m.tags.join(' '))}"></label>
      <label class="check-field"><input type="checkbox" name="pinned" ${m.pinned ? 'checked' : ''}><span>목록 맨 위에 고정</span></label>
      <div class="form-actions">
        ${memo ? '<button class="btn btn-danger" type="button" data-action="delete-memo">삭제</button>' : ''}
        <span class="spacer"></span>
        <button class="btn" type="button" data-action="close-sheet">취소</button>
        <button class="btn btn-primary" type="submit">저장</button>
      </div>
    </form>`);
}

function settingsSheet() {
  const s = store.getState();
  openSheet(`
    ${sheetHead('설정')}
    <form class="form" data-form="settings">
      <label class="field"><span>이름</span><input class="input" name="name" value="${esc(s.settings.name)}"></label>
      <label class="field"><span>화면 테마</span>
        <select class="input" name="theme">
          ${[['auto', '기기 설정 따르기'], ['light', '밝게'], ['dark', '어둡게']].map(([k, label]) => `<option value="${k}" ${s.settings.theme === k ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </label>

      <h3 class="group-title">기기 간 동기화</h3>
      <div id="sync-panel" class="panel">${syncPanelHtml()}</div>

      <h3 class="group-title">알림 (알람·아침 브리핑)</h3>
      <div id="push-panel" class="panel">${pushPanelHtml()}</div>

      <h3 class="group-title">데이터</h3>
      <p class="hint">${sync.isConnected()
    ? '데이터는 이 기기와 연결된 GitHub 저장소에 함께 저장됩니다. 그래도 가끔 백업 파일을 받아 두면 안전합니다.'
    : '동기화를 연결하지 않으면 데이터는 이 기기의 브라우저에만 저장됩니다. 기기를 바꾸거나 브라우저 데이터를 지우기 전에 백업해 두세요.'}</p>
      <div class="btn-row">
        <button class="btn" type="button" data-action="export-json">백업 내보내기</button>
        <button class="btn" type="button" data-action="import-json">백업 가져오기</button>
        <button class="btn" type="button" data-action="export-md">마크다운으로 내보내기</button>
      </div>
      <label class="field"><span>마크다운 체크리스트에서 할 일 가져오기</span>
        <textarea class="input" name="markdown" rows="4" placeholder="- [ ] 내일까지 견적서 회신 #업무&#10;- [ ] 분기 보고서 제출 ⏫ 📅 2026-11-20"></textarea>
      </label>
      <div class="btn-row">
        <button class="btn" type="button" data-action="import-md">할 일 가져오기</button>
        <button class="btn" type="button" data-action="seed-demo">예시 데이터 넣기</button>
        <button class="btn btn-danger" type="button" data-action="clear-all">모든 데이터 삭제</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>

      <div class="form-actions">
        <span class="spacer"></span>
        <button class="btn" type="button" data-action="close-sheet">닫기</button>
        <button class="btn btn-primary" type="submit">저장</button>
      </div>
    </form>
    <form id="sync-connect-form" data-form="sync-connect" hidden></form>`);
}

// ───────── 동기화·알림 패널 ─────────

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?name=daniel-assistant-sync&description=Daniel%27s%20%EA%B0%9C%EC%9D%B8%20%EB%B9%84%EC%84%9C%20%EB%8F%99%EA%B8%B0%ED%99%94&contents=write';

function syncStatusLine() {
  const st = sync.getStatus();
  const c = sync.getConfig();
  const when = st.lastSyncAt
    ? new Date(st.lastSyncAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
  if (st.state === 'syncing') return { cls: 'is-busy', text: '동기화 중…' };
  if (st.state === 'error') return { cls: 'is-error', text: st.error || '동기화 오류' };
  if (st.state === 'offline') return { cls: 'is-warn', text: `오프라인 — 연결되면 자동으로 동기화합니다${when ? ` (마지막 ${when})` : ''}` };
  return { cls: 'is-ok', text: `${c.owner}/${c.repo}${when ? ` · 마지막 동기화 ${when}` : ''}` };
}

function syncPanelHtml() {
  if (ui.stopScanner) {
    return `
      <p class="hint">다른 기기(PC)의 설정 화면에 띄운 QR 코드를 비춰 주세요.</p>
      <video class="scanner" playsinline muted></video>
      <div class="btn-row"><button class="btn" type="button" data-action="sync-scan-cancel">취소</button></div>`;
  }
  if (sync.isConnected()) {
    const line = syncStatusLine();
    return `
      <p class="sync-status ${line.cls}">${icon(line.cls === 'is-error' ? 'alert' : 'cloud')}<span>${esc(line.text)}</span></p>
      <div class="btn-row">
        <button class="btn" type="button" data-action="sync-now" ${ui.syncBusy ? 'disabled' : ''}>지금 동기화</button>
        <button class="btn" type="button" data-action="sync-show-qr" aria-expanded="${ui.showQr}">${icon('qr')}다른 기기 연결</button>
        <button class="btn btn-danger" type="button" data-action="sync-disconnect">연결 해제</button>
      </div>
      ${ui.showQr ? `
        <div class="qr-box" id="qr-box"><p class="hint">QR 코드를 만드는 중…</p></div>
        <p class="hint">다른 기기에서 이 앱을 열고 <b>설정 → 기기 간 동기화 → QR 코드로 연결</b>을 눌러 이 화면을 비추세요. QR 코드에는 GitHub 토큰이 들어 있으니 다른 사람에게 보여 주지 마세요.</p>
        <div class="btn-row"><button class="btn btn-small" type="button" data-action="sync-copy-link">${icon('copy')}연결 링크 복사</button></div>` : ''}`;
  }
  if (ui.repoChoices) {
    return `
      <p class="hint">이 토큰으로 쓸 수 있는 비공개 저장소가 여러 개입니다. 데이터를 저장할 저장소를 고르세요.</p>
      <div class="choices">
        ${ui.repoChoices.map((r, i) => `
          <label class="check-field"><input type="radio" name="syncRepo" value="${i}" form="sync-connect-form" ${i === 0 ? 'checked' : ''}><span>${esc(r.fullName)}</span></label>`).join('')}
      </div>
      <div class="btn-row">
        <button class="btn" type="button" data-action="sync-cancel-choice">취소</button>
        <button class="btn btn-primary" type="submit" form="sync-connect-form" ${ui.syncBusy ? 'disabled' : ''}>이 저장소로 연결</button>
      </div>`;
  }
  return `
    <p class="hint">PC와 폰이 같은 할 일·일정·메모를 보도록, 데이터를 본인의 GitHub <b>비공개</b> 저장소에 저장합니다.
      처음 한 기기(PC 권장)에서 토큰으로 연결하고, 나머지 기기는 그 화면의 QR 코드를 찍으면 됩니다.</p>
    <div class="btn-row"><button class="btn" type="button" data-action="sync-scan">${icon('qr')}QR 코드로 연결</button></div>
    <label class="field"><span>또는 GitHub 토큰 붙여 넣기</span>
      <input class="input" name="syncToken" type="password" form="sync-connect-form" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false">
    </label>
    <details class="help">
      <summary>토큰 만드는 방법 (PC에서 한 번만)</summary>
      <ol>
        <li><a href="${TOKEN_URL}" target="_blank" rel="noopener noreferrer">GitHub 토큰 만들기 화면</a>을 엽니다.</li>
        <li><b>Expiration</b>은 길게(예: 1년) 정합니다. 만료되면 새 토큰으로 다시 연결해야 합니다.</li>
        <li><b>Repository access</b>에서 <b>Only select repositories</b>를 고르고, 데이터를 둘 <b>비공개 저장소 하나</b>만 선택합니다.</li>
        <li><b>Permissions</b>에서 <b>Contents</b>를 <b>Read and write</b>로 정합니다. 다른 권한은 필요 없습니다.</li>
        <li><b>Generate token</b>을 누르고 나온 토큰을 복사해 위 칸에 붙여 넣습니다.</li>
      </ol>
      <p>토큰은 이 기기에만 저장되고, 데이터 파일에는 들어가지 않습니다.</p>
    </details>
    <div class="btn-row"><button class="btn btn-primary" type="submit" form="sync-connect-form" ${ui.syncBusy ? 'disabled' : ''}>${ui.syncBusy ? '확인 중…' : '연결'}</button></div>`;
}

function pushPanelHtml() {
  const intro = '<p class="hint">켜 두면 앱이 꺼져 있어도 할 일·일정 <b>알람</b>과 매일 오전 8시 <b>아침 브리핑</b>(오늘 할 일·미완료 업무·메모 요약)이 이 기기로 옵니다. 알림을 누르면 해당 화면이 열립니다.</p>';
  if (!sync.isConnected()) return `${intro}<p class="hint">기기 간 동기화를 먼저 연결해야 켤 수 있습니다.</p>`;
  const reason = push.unsupportedReason();
  const devices = push.receivingDevices();
  const others = devices.filter((d) => !d.here).map((d) => d.label);
  const list = devices.length
    ? `<p class="hint">알림 받는 기기: ${esc(devices.map((d) => (d.here ? `${d.label}(이 기기)` : d.label)).join(', '))}</p>` : '';
  if (reason) return `${intro}<p class="hint">${esc(reason)}</p>${list}`;
  const on = push.isEnabledHere();
  const s = store.getState();
  const me = s.devices[sync.deviceId()];
  const needsRedo = !on && me && me.push && Notification.permission === 'granted';
  const err = ui.pushError;
  return `
    ${intro}
    <p class="sync-status ${on ? 'is-ok' : ''}">${icon('bell')}<span>이 기기: ${on ? '켜짐' : '꺼짐'}${!on && others.length ? ` · ${esc(others.join(', '))}에서 받는 중` : ''}</span></p>
    <div class="btn-row">
      ${on
    ? `<button class="btn" type="button" data-action="push-disable" ${ui.pushBusy ? 'disabled' : ''}>이 기기 알림 끄기</button>`
    : `<button class="btn btn-primary" type="button" data-action="push-enable" ${ui.pushBusy ? 'disabled' : ''}>${ui.pushBusy ? esc(ui.pushBusy) : needsRedo ? '알림 다시 켜기' : '이 기기에서 알림 받기'}</button>`}
      <button class="btn" type="button" data-action="push-test">지금 브리핑 알림 보기</button>
    </div>
    ${needsRedo ? '<p class="hint">다른 기기와 알림 키가 바뀌어 이 기기는 다시 켜야 합니다.</p>' : ''}
    ${err ? `<div class="sync-status is-error">${icon('alert')}<span>${esc(err.message)}${err.step ? `<br><small>멈춘 단계: ${esc(err.step)}${err.permission ? ` · 권한 상태: ${esc(err.permission)}` : ''}${err.detail ? ` · ${esc(err.detail)}` : ''}</small>` : ''}</span></div>` : ''}
    ${err && err.howTo ? permissionHelpHtml(err.howTo) : ''}
    ${list}`;
}

// 권한 창이 뜨지 않을 때 직접 허용하는 방법
function permissionHelpHtml(kind) {
  const host = esc(location.host);
  if (kind === 'samsung') {
    return `
      <div class="help">
        <b>삼성 인터넷에서 알림 허용하기</b>
        <ol>
          <li>휴대폰 <b>설정 → 애플리케이션 → 삼성 인터넷 → 알림</b>에서 <b>알림 허용</b>을 켭니다.</li>
          <li><b>삼성 인터넷</b> 앱을 열고 아래쪽 <b>메뉴(≡) → 설정 → 사이트 및 다운로드 → 알림</b>으로 갑니다.
            <b>알림 허용(사이트가 알림을 요청할 수 있음)</b>이 켜져 있는지 보고, 목록에 <b>${host}</b>가 있으면 <b>허용</b>으로 바꿉니다.</li>
          <li>이 앱을 완전히 닫았다가 다시 열고 <b>이 기기에서 알림 받기</b>를 다시 누릅니다. 이번에는 권한 창이 뜨거나, 이미 허용되어 바로 켜집니다.</li>
        </ol>
        <p>메뉴 이름은 삼성 인터넷 버전에 따라 조금 다를 수 있습니다. 그래도 안 되면 <b>Chrome</b>으로 이 주소를 열어 홈 화면에 다시 설치하고, 설정에서 <b>QR 코드로 연결</b>하면 내용이 그대로 들어옵니다.</p>
      </div>`;
  }
  return `
    <div class="help">
      <b>알림 직접 허용하기</b>
      <ol>
        <li>휴대폰 <b>설정 → 알림</b>(또는 <b>애플리케이션</b>)에서 이 앱이나 앱을 설치한 브라우저의 알림을 허용합니다.</li>
        <li>브라우저의 사이트 설정에서 <b>${host}</b>의 알림을 <b>허용</b>으로 바꿉니다.</li>
        <li>이 앱을 완전히 닫았다가 다시 열고 <b>이 기기에서 알림 받기</b>를 다시 누릅니다.</li>
      </ol>
    </div>`;
}

function refreshPanels() {
  if (!sheet.open) return;
  const sp = document.getElementById('sync-panel');
  const pp = document.getElementById('push-panel');
  // 입력 중인 토큰이나 카메라 화면은 그대로 둔다
  const typing = sp && sp.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (sp && !typing && !ui.stopScanner) sp.innerHTML = syncPanelHtml();
  if (pp) pp.innerHTML = pushPanelHtml();
  if (ui.showQr && sync.isConnected()) renderQr();
}

async function renderQr() {
  const box = document.getElementById('qr-box');
  if (!box || box.dataset.ready) return;
  box.dataset.ready = '1';
  try {
    box.innerHTML = await qrSvg(sync.makeConnectLink(appUrl()));
  } catch (err) {
    box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
  }
}

const appUrl = () => `${location.origin}${location.pathname}`;

async function connectWith(cfg) {
  ui.syncBusy = true;
  refreshPanels();
  try {
    await sync.connect(cfg);
    ui.repoChoices = null;
    ui.pendingToken = '';
    toast(`${cfg.owner}/${cfg.repo} 저장소와 동기화를 연결했습니다.`);
    await push.reconcile();
  } catch (err) {
    toast(err.message);
  } finally {
    ui.syncBusy = false;
    refreshPanels();
    render();
  }
}

async function connectWithToken(token) {
  ui.syncBusy = true;
  refreshPanels();
  let repos;
  try {
    repos = await sync.listRepos(token);
  } catch (err) {
    ui.syncBusy = false;
    refreshPanels();
    toast(err.message);
    return;
  }
  ui.syncBusy = false;
  if (!repos.length) {
    refreshPanels();
    toast('이 토큰으로 쓸 수 있는 비공개 저장소가 없습니다. 토큰을 만들 때 비공개 저장소를 선택했는지 확인해 주세요.');
    return;
  }
  if (repos.length === 1) { await connectWith({ token, ...repos[0] }); return; }
  ui.pendingToken = token;
  ui.repoChoices = repos;
  refreshPanels();
}

// QR 코드나 링크로 받은 연결 정보 사용
async function connectFromPayload(text) {
  const cfg = sync.parseConnectPayload(text);
  if (!cfg) { toast('이 앱의 연결용 QR 코드가 아닙니다.'); return; }
  if (sync.isConnected()) {
    const c = sync.getConfig();
    if (c.owner === cfg.owner && c.repo === cfg.repo) { toast('이미 이 저장소와 연결되어 있습니다.'); return; }
  }
  if (!confirm(`GitHub 저장소 ${cfg.owner}/${cfg.repo}와 동기화를 연결할까요?\n이 기기의 데이터와 저장소의 데이터가 합쳐집니다.`)) return;
  await connectWith(cfg);
}

async function startScan() {
  ui.stopScanner = () => {};
  const sp = document.getElementById('sync-panel');
  if (sp) sp.innerHTML = syncPanelHtml();
  const video = sp && sp.querySelector('video');
  try {
    ui.stopScanner = await startScanner(video, (text) => {
      ui.stopScanner = null;
      refreshPanels();
      connectFromPayload(text);
    }, (err) => { ui.stopScanner = null; refreshPanels(); toast(err.message); });
  } catch (err) {
    ui.stopScanner = null;
    refreshPanels();
    toast(err.message);
  }
}

function stopScan() {
  if (ui.stopScanner) ui.stopScanner();
  ui.stopScanner = null;
}

// ───────── 예시 데이터 ─────────

function seedDemo() {
  const t = today();
  const todos = [
    { title: '분기 보고서 초안 제출', due: t, time: '15:00', priority: 'high', tags: ['업무'] },
    { title: '팀 주간 회의 안건 정리', due: t, priority: 'medium', tags: ['업무'] },
    { title: '운동 30분', due: t, priority: 'low', tags: ['건강'], repeat: 'daily' },
    { title: '견적서 회신', due: addDays(t, -2), priority: 'high', tags: ['업무'] },
    { title: '도서관 책 반납', due: addDays(t, -1), priority: 'low', tags: ['개인'] },
    { title: '클라우드 비용 리포트 검토', due: addDays(t, 1), priority: 'high', tags: ['업무', '기술'] },
    { title: '부모님 생신 선물 주문', due: addDays(t, 3), priority: 'medium', tags: ['개인'] },
    { title: '읽고 싶은 아키텍처 글 정리', priority: 'low', tags: ['기술'] },
  ];
  todos.forEach((x) => store.addTodo(x));
  store.addEvent({ title: '제품 로드맵 회의', date: t, time: '10:30', endTime: '11:30', location: '회의실 B' });
  store.addEvent({ title: '고객사 데모', date: t, time: '16:00', endTime: '17:00', location: '화상 회의' });
  store.addEvent({ title: '치과 검진', date: addDays(t, 1), time: '18:30', location: '강남역' });
  store.addEvent({ title: '가족 저녁 식사', date: addDays(t, 2), time: '19:00' });
  store.addMemo({ title: '온보딩 개선 아이디어', body: '첫 실행 때 예시 데이터를 보여 주면 이탈이 줄어든다.\n체크리스트 3단계로 줄이기.', tags: ['기획'], pinned: true });
  store.addMemo({ title: '주간 기술 브리핑', body: '이번 주 요약: 주요 프레임워크 릴리스, 보안 패치 일정, 팀에서 살펴볼 만한 도구.\n(정기 브리핑 내용을 여기에 붙여 넣어 보관합니다.)', tags: [store.BRIEFING_TAG, '기술'] });
  store.addMemo({ title: '장보기 목록', body: '우유, 계란, 닭가슴살, 방울토마토', tags: ['개인'] });
}

// ───────── 동작 ─────────

const ACTIONS = {
  'open-settings': () => settingsSheet(),
  'close-sheet': () => closeSheet(),

  'quick-mode': (el) => {
    const text = view.querySelector('[data-form="quick"] input').value;
    ui.quickMode = el.dataset.mode;
    render();
    const input = view.querySelector('[data-form="quick"] input');
    input.value = text;
    input.focus();
    quickPreview(input.form);
  },

  'goto-todos-today': () => { ui.todoScope = 'today'; location.hash = '#todos'; },
  'scroll-alerts': () => document.getElementById('alerts').scrollIntoView({ behavior: 'smooth', block: 'start' }),

  'toggle-todo': (el) => {
    const res = store.toggleTodo(el.dataset.id);
    if (res && res.spawned) toast(`다음 회차를 ${formatRelative(res.spawned.due)}로 만들었습니다.`);
  },
  'edit-todo': (el) => {
    const todo = store.getState().todos.find((x) => x.id === el.dataset.id);
    if (todo) todoSheet(todo);
  },
  'delete-todo': (el) => {
    if (!confirm('이 할 일을 삭제할까요?')) return;
    store.deleteTodo(el.closest('form').dataset.id);
    closeSheet();
  },
  postpone: (el) => {
    const to = addDays(today(), Number(el.dataset.days));
    store.postponeTodo(el.dataset.id, to);
    toast(`${formatRelative(to)}(으)로 옮겼습니다.`);
  },
  'todo-scope': (el) => { ui.todoScope = el.dataset.value; render(); },
  'todo-priority': (el) => { ui.todoPriority = el.dataset.value; render(); },
  'todo-tag': (el) => { ui.todoTag = ui.todoTag === el.dataset.value ? '' : el.dataset.value; render(); },

  'cal-move': (el) => {
    ui.calMonth = addMonths(`${ui.calMonth}-01`, Number(el.dataset.step)).slice(0, 7);
    ui.calDay = ui.calMonth === today().slice(0, 7) ? today() : `${ui.calMonth}-01`;
    render();
  },
  'cal-today': () => { ui.calMonth = today().slice(0, 7); ui.calDay = today(); render(); },
  'cal-day': (el) => { ui.calDay = el.dataset.date; ui.calMonth = ui.calDay.slice(0, 7); render(); },
  'new-event': () => eventSheet(null, ui.calDay),
  'open-event': (el) => {
    const ev = store.getState().events.find((e) => e.id === el.dataset.id);
    if (ev) eventSheet(ev, null, el.dataset.date);
  },
  'delete-event': (el) => {
    const ev = store.getState().events.find((e) => e.id === el.closest('form').dataset.id);
    if (!confirm(ev && ev.repeat ? '반복 일정 전체를 삭제할까요?' : '이 일정을 삭제할까요?')) return;
    store.deleteEvent(el.closest('form').dataset.id);
    closeSheet();
  },
  // 반복 일정에서 이 날짜만 빼기
  'skip-occurrence': (el) => {
    const form = el.closest('form');
    const ev = store.getState().events.find((e) => e.id === form.dataset.id);
    const day = form.dataset.occurrence;
    if (!ev || !day || !confirm(`${formatLong(day)} 일정만 삭제할까요?`)) return;
    store.updateEvent(ev.id, { exdates: [...(ev.exdates || []), day] });
    closeSheet();
    toast(`${formatShort(day)} 일정만 삭제했습니다.`);
  },

  'new-memo': () => memoSheet(null),
  'new-briefing': () => memoSheet(null, { title: `${formatShort(today())} 기술 브리핑`, tags: [store.BRIEFING_TAG] }),
  'edit-memo': (el) => {
    const memo = store.getState().memos.find((m) => m.id === el.dataset.id);
    if (memo) memoSheet(memo);
  },
  'delete-memo': (el) => {
    if (!confirm('이 메모를 삭제할까요?')) return;
    store.deleteMemo(el.closest('form').dataset.id);
    closeSheet();
  },
  'memo-tag': (el) => { ui.memoTag = el.dataset.value; render(); },

  'copy-briefing': async () => {
    const text = buildBriefing(store.getState()).markdown;
    try {
      await navigator.clipboard.writeText(text);
      toast('브리핑을 복사했습니다.');
    } catch {
      toast('복사하지 못했습니다. 브라우저 권한을 확인해 주세요.');
    }
  },

  'export-json': () => {
    const s = store.getState();
    const backup = { version: 1, settings: s.settings, todos: s.todos, events: s.events, memos: s.memos };
    download(`개인비서-백업-${today()}.json`, JSON.stringify(backup, null, 2), 'application/json');
  },
  'export-md': () => download(`개인비서-${today()}.md`, exportMarkdown(store.getState()), 'text/markdown'),
  'import-json': () => document.getElementById('import-file').click(),
  'import-md': (el) => {
    const todos = parseMarkdownTasks(el.closest('form').elements.markdown.value);
    if (!todos.length) { toast('가져올 체크리스트 항목( - [ ] … )을 찾지 못했습니다.'); return; }
    store.mergeTodos(todos);
    el.closest('form').elements.markdown.value = '';
    toast(`할 일 ${todos.length}건을 가져왔습니다.`);
  },
  'sync-scan': () => startScan(),
  'sync-scan-cancel': () => { stopScan(); refreshPanels(); },
  'sync-cancel-choice': () => { ui.repoChoices = null; ui.pendingToken = ''; refreshPanels(); },
  'sync-now': async () => {
    await sync.syncNow();
    await push.reconcile();
    const st = sync.getStatus();
    toast(st.state === 'idle' ? '동기화했습니다.' : st.error || '동기화하지 못했습니다.');
  },
  'sync-show-qr': () => { ui.showQr = !ui.showQr; refreshPanels(); },
  'sync-copy-link': async () => {
    try {
      await navigator.clipboard.writeText(sync.makeConnectLink(appUrl()));
      toast('연결 링크를 복사했습니다. 토큰이 들어 있으니 본인에게만 보내세요.');
    } catch {
      toast('복사하지 못했습니다.');
    }
  },
  'sync-disconnect': async () => {
    if (!confirm('이 기기의 동기화를 해제할까요?\n이 기기의 데이터는 그대로 남고, 다른 기기와 더 이상 맞춰지지 않습니다. 이 기기의 아침 알림도 꺼집니다.')) return;
    if (push.isEnabledHere()) await push.disable().catch(() => {});
    sync.disconnect();
    ui.showQr = false;
    refreshPanels();
    render();
    toast('동기화를 해제했습니다.');
  },
  'push-enable': async () => {
    ui.pushBusy = '알림 권한 확인 중…';
    ui.pushError = null;
    refreshPanels();
    try {
      const { saved } = await push.enable((step) => { ui.pushBusy = step; refreshPanels(); });
      toast(saved
        ? '이 기기에서 매일 아침 브리핑 알림을 받습니다.'
        : '알림은 켰지만 아직 저장하지 못했습니다. 인터넷이 연결되면 자동으로 저장됩니다.');
    } catch (err) {
      ui.pushError = { step: err.step || '', message: err.message, detail: err.detail || '', howTo: err.howTo || '', permission: err.permission || '' };
      toast(err.message);
    } finally {
      ui.pushBusy = false;
      refreshPanels();
    }
  },
  'push-disable': async () => {
    ui.pushBusy = true;
    refreshPanels();
    try {
      await push.disable();
      toast('이 기기의 아침 알림을 껐습니다.');
    } catch (err) {
      toast(err.message);
    } finally {
      ui.pushBusy = false;
      refreshPanels();
    }
  },
  'push-test': async () => {
    try { await push.testNotification(); } catch (err) { toast(err.message); }
  },
  'seed-demo': () => { seedDemo(); closeSheet(); toast('예시 데이터를 넣었습니다.'); },
  'clear-all': () => {
    const where = sync.isConnected() ? '\n동기화 중이라 연결된 모든 기기에서 함께 지워집니다.' : '';
    if (!confirm(`할 일·일정·메모를 모두 삭제합니다. 되돌릴 수 없습니다.${where}\n계속할까요?`)) return;
    store.clearAll();
    closeSheet();
    toast('모든 데이터를 삭제했습니다.');
  },
};

const FORMS = {
  quick: (form) => {
    const input = form.elements.text;
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    input.value = '';
    const mode = form.dataset.mode;
    const t = today();
    if (mode === 'memo') {
      const tags = [];
      const body = text.replace(/(^|\s)#([^\s#]+)/g, (m, sp, tag) => { tags.push(tag); return sp; }).replace(/\s+/g, ' ').trim();
      if (!body) { input.value = text; toast('메모 내용을 입력해 주세요.'); return; }
      store.addMemo(body.length > 40 ? { title: `${body.slice(0, 40)}…`, body, tags } : { title: body, tags });
      toast('메모를 저장했습니다.');
    } else {
      const p = parseQuickInput(text);
      if (!p.title) { input.value = text; toast('제목이 될 내용을 함께 적어 주세요.'); return; }
      if (mode === 'event') {
        const date = p.due || t;
        store.addEvent({ title: p.title, date, endDate: p.endDate, time: p.time, remind: p.remind, repeat: p.repeat });
        toast(`일정을 추가했습니다 · ${p.repeat ? `${REPEAT_LABEL[p.repeat]} 반복, 첫 일정 ` : ''}${p.endDate ? `${formatShort(date)} ~ ${formatShort(p.endDate)}` : formatRelative(date, t)}${p.time ? ` ${formatTime(p.time)}` : ''}`);
      } else {
        // 할 일에 기간을 쓰면 마지막 날을 마감으로 본다
        const { endDate, ...todo } = p;
        if (endDate) todo.due = endDate;
        store.addTodo(todo);
        p.due = todo.due;
        toast(p.due ? `할 일을 추가했습니다 · ${formatRelative(p.due, t)}${p.time ? ` ${formatTime(p.time)}` : ''}` : '할 일을 추가했습니다.');
      }
    }
    const next = view.querySelector('[data-form="quick"] input');
    if (next) next.focus();
  },

  todo: (form) => {
    const f = form.elements;
    const title = f.title.value.trim();
    if (!title) return;
    const fields = {
      title,
      due: f.due.value || null,
      time: f.time.value || null,
      priority: f.priority.value || 'medium',
      repeat: f.repeat.value || null,
      remind: f.remind.value === '' ? null : Number(f.remind.value),
      tags: parseTags(f.tags.value),
      notes: f.notes.value.trim(),
    };
    if (fields.time && !fields.due) fields.due = today();
    if (fields.remind != null && !fields.due) fields.due = today();
    if (fields.repeat && !fields.due) fields.due = today();
    if (form.dataset.id) store.updateTodo(form.dataset.id, fields);
    else store.addTodo(fields);
    closeSheet();
  },

  event: (form) => {
    const f = form.elements;
    const title = f.title.value.trim();
    if (!title || !f.date.value) return;
    const endDate = f.endDate.value && f.endDate.value !== f.date.value ? f.endDate.value : null;
    if (endDate && endDate < f.date.value) { toast('종료일이 시작일보다 앞설 수 없습니다.'); f.endDate.focus(); return; }
    const fields = {
      title,
      date: f.date.value,
      endDate,
      time: f.time.value || null,
      endTime: f.time.value ? (f.endTime.value || null) : null,
      remind: f.remind.value === '' ? null : Number(f.remind.value),
      repeat: f.repeat.value || null,
      repeatUntil: f.repeat.value && f.repeatUntil.value ? f.repeatUntil.value : null,
      location: f.location.value.trim(),
      notes: f.notes.value.trim(),
    };
    if (form.dataset.id) store.updateEvent(form.dataset.id, fields);
    else store.addEvent(fields);
    // 반복 일정의 한 회차에서 고쳤으면 보던 날짜에 머문다
    const stay = form.dataset.occurrence && fields.repeat ? form.dataset.occurrence : null;
    ui.calDay = stay || fields.date;
    ui.calMonth = ui.calDay.slice(0, 7);
    closeSheet();
    render();
  },

  memo: (form) => {
    const f = form.elements;
    const fields = {
      title: f.title.value.trim(),
      body: f.body.value.trim(),
      tags: parseTags(f.tags.value),
      pinned: f.pinned.checked,
    };
    if (!fields.title && !fields.body) { toast('제목이나 내용을 입력해 주세요.'); return; }
    if (!fields.title) fields.title = fields.body.split('\n')[0].slice(0, 40);
    if (form.dataset.id) store.updateMemo(form.dataset.id, fields);
    else store.addMemo(fields);
    closeSheet();
  },

  'sync-connect': (form) => {
    if (ui.repoChoices) {
      const picked = form.elements.syncRepo;
      const idx = Number(picked && picked.value !== undefined ? picked.value : 0);
      connectWith({ token: ui.pendingToken, ...ui.repoChoices[idx] || ui.repoChoices[0] });
      return;
    }
    const input = form.elements.syncToken;
    const token = input ? input.value.trim() : '';
    if (!token) { toast('GitHub 토큰을 붙여 넣어 주세요.'); if (input) input.focus(); return; }
    // 연결 링크를 통째로 붙여 넣은 경우
    if (/#connect=/.test(token)) { connectFromPayload(token); return; }
    if (!/^[\w-]{20,255}$/.test(token)) { toast('토큰 형식이 아닙니다. github_pat_ 으로 시작하는 값을 그대로 붙여 넣어 주세요.'); return; }
    connectWithToken(token);
  },

  settings: (form) => {
    const f = form.elements;
    store.setSettings({
      name: f.name.value.trim() || 'Daniel',
      theme: f.theme.value,
    });
    closeSheet();
    toast('설정을 저장했습니다.');
  },
};

// ───────── 이벤트 연결 ─────────

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && ACTIONS[el.dataset.action]) {
    ACTIONS[el.dataset.action](el, e);
    return;
  }
  // 시트 바깥(배경)을 누르면 닫는다
  if (e.target === sheet) closeSheet();
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  FORMS[form.dataset.form](form);
});

document.addEventListener('change', (e) => {
  // 일정 시작일을 바꾸면 종료일이 그보다 앞서지 않게 한다
  if (e.target.name === 'date' && e.target.form && e.target.form.dataset.form === 'event') {
    const end = e.target.form.elements.endDate;
    end.min = e.target.value;
    if (end.value && end.value < e.target.value) end.value = '';
    const until = e.target.form.elements.repeatUntil;
    if (until) {
      until.min = e.target.value;
      if (until.value && until.value < e.target.value) until.value = '';
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'memo-search') {
    ui.memoQuery = e.target.value;
    document.getElementById('memo-results').innerHTML = memoListHtml();
    return;
  }
  const quick = e.target.closest('[data-form="quick"]');
  if (quick) quickPreview(quick);
});

document.addEventListener('change', (e) => {
  if (e.target.id !== 'import-file') return;
  const file = e.target.files[0];
  if (!file) return;
  file.text().then((text) => {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || !Array.isArray(data.todos)) throw new Error('형식 오류');
    if (!confirm('현재 데이터를 백업 파일의 내용으로 바꿉니다. 계속할까요?')) return;
    store.replaceAll(data);
    closeSheet();
    toast('백업을 불러왔습니다.');
  }).catch(() => toast('백업 파일을 읽지 못했습니다. 이 앱에서 내보낸 JSON 파일인지 확인해 주세요.'));
});

sheet.addEventListener('close', () => {
  setTimeout(applyUpdateIfIdle, 0);
  stopScan();
  ui.showQr = false;
  ui.repoChoices = null;
  ui.pendingToken = '';
  sheet.innerHTML = '';
  if (pendingRender) render();
});

window.addEventListener('hashchange', route);

// 날짜가 바뀌거나 알림 시각이 지나도 화면이 맞도록 주기적으로 다시 그린다.
let pendingRender = false;
function refreshIfIdle() {
  const active = document.activeElement;
  const typing = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
  if (!sheet.open && !typing) render();
  else pendingRender = true;
}
// 입력을 마치면 미뤄 둔 화면 갱신(과 앱 업데이트)을 한다
document.addEventListener('focusout', () => {
  setTimeout(() => {
    applyUpdateIfIdle();
    const a = document.activeElement;
    if (pendingRender && !sheet.open && !(a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName))) render();
  }, 0);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfIdle(); });
setInterval(() => { if (!document.hidden && ui.tab === 'home') refreshIfIdle(); }, 60000);

// ───────── 알람 ─────────
// 앱이 켜져 있는(또는 백그라운드에 있는) 동안 할 일·일정 알람을 울린다.

async function showReminder(r, { late }) {
  const body = late ? `${r.body} (지난 알림)` : r.body;
  let shown = false;
  if ('Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      // 알림 발송기가 이미 보낸 알람이면 다시 울리지 않는다
      const already = await reg.getNotifications({ tag: r.key });
      if (!already.length) await reg.showNotification(r.title, { body, tag: r.key, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', data: { url: r.url } });
      shown = true;
    } catch { /* 앱 안에서라도 알린다 */ }
  }
  if (!document.hidden || !shown) {
    toast(`${r.title} — ${body}`);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }
}

let checkReminders = () => {};

// ───────── 앱 업데이트 ─────────
// 새 버전이 배포되면 열려 있는 앱도 바로 새 버전으로 바꾼다.
// 입력 중이거나 설정·편집 창이 열려 있으면 끝날 때까지 기다렸다가 새로 고친다.

const UPDATE_KEY = 'daniel-assistant.update';
let updateTo = null;
let lastUpdateCheck = 0;

function isBusy() {
  const a = document.activeElement;
  return sheet.open || !!(a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) && a.value);
}

function applyUpdateIfIdle() {
  if (!updateTo || isBusy()) return;
  // 같은 버전으로 두 번 새로 고치지 않는다(서버 반영이 늦을 때 무한 반복 방지)
  let tried = null;
  try { tried = sessionStorage.getItem(UPDATE_KEY); } catch { /* 무시 */ }
  if (tried === updateTo) return;
  try { sessionStorage.setItem(UPDATE_KEY, updateTo); } catch { /* 무시 */ }
  location.reload();
}

async function checkForUpdate() {
  if (APP_VERSION === 'dev' || Date.now() - lastUpdateCheck < 60000) return;
  lastUpdateCheck = Date.now();
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    if (typeof version === 'string' && version !== APP_VERSION) {
      updateTo = version;
      applyUpdateIfIdle();
    }
  } catch { /* 오프라인이면 다음에 확인 */ }
}

// ───────── 시작 ─────────

let localStore = null;
try {
  localStorage.setItem('daniel-assistant.probe', '1');
  localStorage.removeItem('daniel-assistant.probe');
  localStore = localStorage;
} catch {
  setTimeout(() => toast('이 브라우저에서는 저장소를 쓸 수 없어 데이터가 유지되지 않습니다.'), 500);
}
store.init(localStore);
sync.init(localStore);
// 다른 기기에서 온 변경은 입력 중이 아닐 때 화면에 반영한다
store.subscribe((_, meta) => {
  if (meta.remote) refreshIfIdle(); else render();
  refreshPanels();
  checkReminders();
});
sync.onStatus(() => { refreshPanels(); renderSyncIndicator(); });

route();
renderSyncIndicator();
sync.start();

checkReminders = createLocalReminders({ storage: localStore || sessionStorage, getState: store.getState, notify: showReminder });
checkReminders();
setInterval(checkReminders, 30000); // 백그라운드에서 타이머가 늦어져도 다시 확인한다
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkReminders(); });

// 새 버전으로 바뀐 직후라면 알려 준다
try {
  const done = sessionStorage.getItem(UPDATE_KEY);
  if (done && done === APP_VERSION) {
    sessionStorage.removeItem(UPDATE_KEY);
    setTimeout(() => toast('앱을 새 버전으로 업데이트했습니다.'), 400);
  }
} catch { /* 무시 */ }
setTimeout(checkForUpdate, 1500);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  checkForUpdate();
  // 휴대폰 설정에서 알림을 허용하고 돌아오면 안내를 지운다
  if (ui.pushError && 'Notification' in window && Notification.permission === 'granted') {
    ui.pushError = null;
    refreshPanels();
  }
});
setInterval(() => { if (!document.hidden) checkForUpdate(); }, 30 * 60 * 1000);
if (sync.isConnected()) {
  // 첫 동기화가 끝나면 알림 구독 상태를 맞춘다
  const off = sync.onStatus((st) => { if (st.state === 'idle') { off(); push.reconcile(); } });
}

// 알림을 눌러 앱이 열려 있을 때는 서비스 워커가 보낸 주소로 이동한다
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open' && typeof e.data.hash === 'string' && /^#\w+$/.test(e.data.hash)) {
      location.hash = e.data.hash;
    }
  });
}

// 브라우저가 저장 공간을 임의로 비우지 않도록 영구 저장을 요청한다.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('서비스 워커 등록 실패', err));
}
