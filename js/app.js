// Daniel's 개인 비서 — 화면 렌더링과 사용자 상호작용

import * as store from './store.js';
import * as gcal from './gcal.js';
import { parseQuickInput } from './nlp.js';
import { buildBriefing, greeting } from './briefing.js';
import { parseMarkdownTasks, exportMarkdown } from './markdown.js';
import {
  today, addDays, addMonths, diffDays, weekdayOf, startOfWeek, endOfMonth,
  formatLong, formatShort, formatRelative, formatTime, WEEKDAYS,
} from './dates.js';

const TABS = ['home', 'todos', 'calendar', 'memos', 'briefing'];
const PRIORITY_LABEL = { high: '높음', medium: '보통', low: '낮음' };
const REPEAT_LABEL = { daily: '매일', weekly: '매주', monthly: '매월' };

const view = document.getElementById('view');
const sheet = document.getElementById('sheet');
const toastEl = document.getElementById('toast');

const ui = {
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
  mapPin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  refresh: '<path d="M21 2v6h-6M3 22v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L21 8M3 16l2.6 2.4A9 9 0 0 0 20.5 15"/>',
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

function eventRow(ev) {
  const time = ev.allDay || !ev.time ? '종일' : formatTime(ev.time);
  const sub = [
    ev.endTime && ev.time ? `~ ${formatTime(ev.endTime)}` : '',
    ev.location ? ev.location : '',
    ev.source === 'google' ? `Google${ev.calendar ? ` · ${ev.calendar}` : ''}` : '',
  ].filter(Boolean).join(' · ');
  return `
    <li class="row event">
      <button class="row-body event-body" type="button" data-action="open-event" data-id="${esc(ev.id)}">
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
    event: '예: 금요일 저녁 7시 가족 식사',
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
  if (due) chips.push(`<span class="chip chip-accent">${icon('calendar')}${esc(`${formatRelative(due, t)}${p.time ? ` ${formatTime(p.time)}` : ''}`)}</span>`);
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
  const weekEvents = store.eventsBetween(s, t, addDays(t, 7));
  const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const nextEvent = todayEvents.find((e) => e.time && e.time >= nowHM);

  // 예정 일정: 오늘부터 7일, 날짜별로 묶는다
  const groups = new Map();
  weekEvents.forEach((e) => {
    const day = e.date < t ? t : e.date;
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(e);
  });
  const eventGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 5);

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
        <h2>예정 일정</h2>
        <a class="card-link" href="#calendar">캘린더</a>
      </div>
      ${eventGroups.length ? eventGroups.map(([day, list]) => `
        <h3 class="group-title">${esc(formatRelative(day, t))}${diffDays(day, t) > 2 ? '' : ` · ${esc(formatShort(day))}`}</h3>
        <ul class="list">${list.map(eventRow).join('')}</ul>`).join('') : empty('앞으로 7일간 예정된 일정이 없습니다.')}
      ${!s.settings.gcalClientId ? '<button class="btn btn-ghost" type="button" data-action="open-settings">Google Calendar 연결하기</button>' : ''}
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

  let gcalStatus;
  if (!s.settings.gcalClientId) {
    gcalStatus = '<button class="btn btn-ghost" type="button" data-action="open-settings">Google Calendar 연결하기</button>';
  } else if (gcal.isConnected()) {
    gcalStatus = `<button class="btn btn-ghost" type="button" data-action="gcal-sync">${icon('refresh')}Google 일정 새로고침</button>`;
  } else {
    gcalStatus = `<button class="btn btn-ghost" type="button" data-action="gcal-sync">${icon('refresh')}Google Calendar 다시 연결</button>`;
  }
  const fetched = s.gcal.fetchedAt ? `<p class="hint">Google 일정 ${s.gcal.events.length}건 · ${esc(new Date(s.gcal.fetchedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} 기준</p>` : '';

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
      ${dayEvents.length ? `<ul class="list">${dayEvents.map(eventRow).join('')}</ul>` : empty('일정이 없습니다.')}
      ${dayTodos.length ? `<h3 class="group-title">할 일 마감</h3><ul class="list">${dayTodos.map((x) => todoRow(x, t)).join('')}</ul>` : ''}
    </section>

    <section class="card card-flat">${gcalStatus}${fetched}</section>
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
    ? `<ul class="bullets">${sec.items.map((i) => `<li>${sec.memoId ? `<button class="link" type="button" data-action="edit-memo" data-id="${esc(sec.memoId)}">${esc(i)}</button>` : esc(i)}</li>`).join('')}</ul>`
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

const VIEWS = { home: viewHome, todos: viewTodos, calendar: viewCalendar, memos: viewMemos, briefing: viewBriefing };

function render() {
  const s = store.getState();
  view.innerHTML = VIEWS[ui.tab]();
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

function route() {
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

function eventSheet(ev, date) {
  const e = ev || { title: '', date: date || ui.calDay, time: '', endTime: '', location: '', notes: '' };
  openSheet(`
    ${sheetHead(ev ? '일정 수정' : '새 일정')}
    <form class="form" data-form="event" data-id="${esc(ev ? ev.id : '')}">
      <label class="field"><span>제목</span><input class="input" name="title" required value="${esc(e.title)}"></label>
      <label class="field"><span>날짜</span><input class="input" name="date" type="date" required value="${esc(e.date)}"></label>
      <div class="field-row">
        <label class="field"><span>시작</span><input class="input" name="time" type="time" value="${esc(e.time || '')}"></label>
        <label class="field"><span>종료</span><input class="input" name="endTime" type="time" value="${esc(e.endTime || '')}"></label>
      </div>
      <label class="field"><span>장소</span><input class="input" name="location" value="${esc(e.location)}"></label>
      <label class="field"><span>메모</span><textarea class="input" name="notes" rows="3">${esc(e.notes)}</textarea></label>
      <div class="form-actions">
        ${ev ? '<button class="btn btn-danger" type="button" data-action="delete-event">삭제</button>' : ''}
        <span class="spacer"></span>
        <button class="btn" type="button" data-action="close-sheet">취소</button>
        <button class="btn btn-primary" type="submit">저장</button>
      </div>
    </form>`);
}

function googleEventSheet(ev) {
  const when = ev.allDay
    ? `${formatLong(ev.date)}${ev.endDate > ev.date ? ` ~ ${formatLong(ev.endDate)}` : ''} · 종일`
    : `${formatLong(ev.date)} ${formatTime(ev.time)}${ev.endTime ? ` ~ ${formatTime(ev.endTime)}` : ''}`;
  const safeLink = /^https:\/\/(www\.)?google\.com\/calendar\//.test(ev.link || '') ? ev.link : '';
  openSheet(`
    ${sheetHead(ev.title)}
    <div class="form">
      <p class="detail">${icon('clock')}${esc(when)}</p>
      ${ev.location ? `<p class="detail">${icon('mapPin')}${esc(ev.location)}</p>` : ''}
      <p class="detail">${icon('calendar')}Google Calendar${ev.calendar ? ` · ${esc(ev.calendar)}` : ''}</p>
      <p class="hint">Google 일정은 읽기 전용입니다. 수정은 Google Calendar에서 해 주세요.</p>
      <div class="form-actions">
        <span class="spacer"></span>
        ${safeLink ? `<a class="btn" href="${esc(safeLink)}" target="_blank" rel="noopener noreferrer">Google Calendar에서 열기</a>` : ''}
        <button class="btn btn-primary" type="button" data-action="close-sheet">닫기</button>
      </div>
    </div>`);
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
  gcal.preload().catch(() => {});
  openSheet(`
    ${sheetHead('설정')}
    <form class="form" data-form="settings">
      <label class="field"><span>이름</span><input class="input" name="name" value="${esc(s.settings.name)}"></label>
      <label class="field"><span>화면 테마</span>
        <select class="input" name="theme">
          ${[['auto', '기기 설정 따르기'], ['light', '밝게'], ['dark', '어둡게']].map(([k, label]) => `<option value="${k}" ${s.settings.theme === k ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </label>

      <h3 class="group-title">Google Calendar</h3>
      <label class="field"><span>OAuth 클라이언트 ID</span>
        <input class="input" name="gcalClientId" placeholder="xxxxxxxx.apps.googleusercontent.com" value="${esc(s.settings.gcalClientId)}" autocapitalize="off" spellcheck="false">
      </label>
      <details class="help">
        <summary>클라이언트 ID 만드는 방법</summary>
        <ol>
          <li>Google Cloud Console에서 프로젝트를 만들고 <b>Google Calendar API</b>를 사용 설정합니다.</li>
          <li>OAuth 동의 화면을 만들고, 테스트 사용자에 본인 Google 계정을 추가합니다.</li>
          <li>사용자 인증 정보에서 <b>OAuth 클라이언트 ID(웹 애플리케이션)</b>를 만들고, 승인된 JavaScript 원본에 <code>${esc(location.origin)}</code> 을 추가합니다.</li>
          <li>발급된 클라이언트 ID를 위 칸에 붙여 넣고 저장한 뒤 연결합니다.</li>
        </ol>
        <p>일정은 읽기 전용으로 가져오며, 이 기기 밖으로 보내지 않습니다.</p>
      </details>
      <div class="btn-row">
        <button class="btn" type="button" data-action="gcal-connect">${gcal.isConnected() ? '일정 새로고침' : '연결'}</button>
        ${s.gcal.fetchedAt ? '<button class="btn" type="button" data-action="gcal-disconnect">연결 해제</button>' : ''}
      </div>

      <h3 class="group-title">데이터</h3>
      <p class="hint">모든 데이터는 이 기기의 브라우저에만 저장됩니다. 기기를 바꾸거나 브라우저 데이터를 지우기 전에 백업해 두세요.</p>
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
    </form>`);
}

// ───────── Google Calendar ─────────

async function syncGcal({ interactive }) {
  const s = store.getState();
  try {
    if (!gcal.isConnected()) {
      if (!interactive) return;
      await gcal.connect(s.settings.gcalClientId);
    }
    const events = await gcal.fetchEvents();
    store.setGcalEvents(events);
    if (interactive) toast(`Google 일정 ${events.length}건을 불러왔습니다.`);
  } catch (err) {
    if (interactive) toast(err.message);
    else console.warn(err);
  }
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

const findEvent = (id) => store.allEvents(store.getState()).find((e) => e.id === id);

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
    const ev = findEvent(el.dataset.id);
    if (!ev) return;
    if (ev.source === 'google') googleEventSheet(ev);
    else eventSheet(store.getState().events.find((e) => e.id === ev.id));
  },
  'delete-event': (el) => {
    if (!confirm('이 일정을 삭제할까요?')) return;
    store.deleteEvent(el.closest('form').dataset.id);
    closeSheet();
  },
  'gcal-sync': () => syncGcal({ interactive: true }),
  'gcal-connect': (el) => {
    const form = el.closest('form');
    const id = form.elements.gcalClientId.value.trim();
    store.setSettings({ gcalClientId: id });
    syncGcal({ interactive: true }).then(() => { if (sheet.open) settingsSheet(); });
  },
  'gcal-disconnect': () => {
    gcal.disconnect();
    store.clearGcal();
    toast('Google Calendar 연결을 해제했습니다.');
    settingsSheet();
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
    download(`개인비서-백업-${today()}.json`, JSON.stringify({ ...s, gcal: { events: [], fetchedAt: null } }, null, 2), 'application/json');
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
  'seed-demo': () => { seedDemo(); closeSheet(); toast('예시 데이터를 넣었습니다.'); },
  'clear-all': () => {
    if (!confirm('할 일·일정·메모를 모두 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return;
    gcal.disconnect();
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
    const mode = form.dataset.mode;
    const t = today();
    if (mode === 'memo') {
      const tags = [];
      const body = text.replace(/(^|\s)#([^\s#]+)/g, (m, sp, tag) => { tags.push(tag); return sp; }).replace(/\s+/g, ' ').trim();
      if (!body) { toast('메모 내용을 입력해 주세요.'); return; }
      store.addMemo(body.length > 40 ? { title: `${body.slice(0, 40)}…`, body, tags } : { title: body, tags });
      toast('메모를 저장했습니다.');
    } else {
      const p = parseQuickInput(text);
      if (!p.title) { toast('제목이 될 내용을 함께 적어 주세요.'); return; }
      if (mode === 'event') {
        const date = p.due || t;
        store.addEvent({ title: p.title, date, time: p.time });
        toast(`일정을 추가했습니다 · ${formatRelative(date, t)}${p.time ? ` ${formatTime(p.time)}` : ''}`);
      } else {
        store.addTodo(p);
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
      tags: parseTags(f.tags.value),
      notes: f.notes.value.trim(),
    };
    if (fields.time && !fields.due) fields.due = today();
    if (fields.repeat && !fields.due) fields.due = today();
    if (form.dataset.id) store.updateTodo(form.dataset.id, fields);
    else store.addTodo(fields);
    closeSheet();
  },

  event: (form) => {
    const f = form.elements;
    const title = f.title.value.trim();
    if (!title || !f.date.value) return;
    const fields = {
      title,
      date: f.date.value,
      time: f.time.value || null,
      endTime: f.time.value ? (f.endTime.value || null) : null,
      location: f.location.value.trim(),
      notes: f.notes.value.trim(),
    };
    if (form.dataset.id) store.updateEvent(form.dataset.id, fields);
    else store.addEvent(fields);
    ui.calDay = fields.date;
    ui.calMonth = fields.date.slice(0, 7);
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

  settings: (form) => {
    const f = form.elements;
    store.setSettings({
      name: f.name.value.trim() || 'Daniel',
      theme: f.theme.value,
      gcalClientId: f.gcalClientId.value.trim(),
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

sheet.addEventListener('close', () => { sheet.innerHTML = ''; });

window.addEventListener('hashchange', route);

// 날짜가 바뀌거나 알림 시각이 지나도 화면이 맞도록 주기적으로 다시 그린다.
function refreshIfIdle() {
  const active = document.activeElement;
  const typing = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
  if (!sheet.open && !typing) render();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfIdle(); });
setInterval(() => { if (!document.hidden && ui.tab === 'home') refreshIfIdle(); }, 60000);

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
store.subscribe(() => render());
route();

if (store.getState().settings.gcalClientId) {
  gcal.preload().catch(() => {});
  syncGcal({ interactive: false });
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('서비스 워커 등록 실패', err));
}
