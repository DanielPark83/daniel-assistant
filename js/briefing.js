// 매일 브리핑: 저장된 할 일·일정·메모에서 오늘의 요약을 만든다.

import { toISODate, addDays, diffDays, formatLong, formatRelative, formatTime } from './dates.js';
import {
  BRIEFING_TAG, overdueTodos, todosDueOn, todosDoneOn, eventsOn, eventsBetween, compareTodos,
} from './store.js';

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

export function greeting(now = new Date()) {
  const h = now.getHours();
  if (h < 5) return '늦은 밤입니다';
  if (h < 12) return '좋은 아침입니다';
  if (h < 18) return '좋은 오후입니다';
  return '좋은 저녁입니다';
}

const eventLine = (e) => `${e.allDay || !e.time ? '종일' : formatTime(e.time)} ${e.title}${e.location ? ` · ${e.location}` : ''}`;
const todoLine = (t) => `${t.title}${t.time ? ` (${formatTime(t.time)})` : ''}${t.priority === 'high' ? ' · 중요' : ''}`;

export function buildBriefing(state, now = new Date()) {
  const t = toISODate(now);
  const todayTodos = todosDueOn(state, t);
  const overdue = overdueTodos(state, t);
  const todayEvents = eventsOn(state, t);
  const doneYesterday = todosDoneOn(state, addDays(t, -1));
  const doneToday = todosDoneOn(state, t);
  const upcoming = state.todos
    .filter((x) => !x.done && x.due && diffDays(x.due, t) >= 1 && diffDays(x.due, t) <= 7)
    .sort(compareTodos);
  const upcomingEvents = eventsBetween(state, addDays(t, 1), addDays(t, 3)).filter((e) => e.date > t);
  const noDate = state.todos.filter((x) => !x.done && !x.due);
  const techBrief = state.memos
    .filter((m) => m.tags.includes(BRIEFING_TAG))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;

  // 오늘의 핵심: 지연·오늘 마감 중 중요도가 높은 순으로 최대 3개
  const focus = [...overdue, ...todayTodos]
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || compareTodos(a, b))
    .slice(0, 3);

  const parts = [];
  parts.push(todayEvents.length ? `일정 ${todayEvents.length}건` : '일정 없음');
  parts.push(todayTodos.length ? `오늘 할 일 ${todayTodos.length}건` : '오늘 마감인 할 일 없음');
  if (overdue.length) parts.push(`미완료 ${overdue.length}건 이월`);
  const headline = `${parts.join(', ')}.`;

  const sections = [];
  if (focus.length) {
    sections.push({ key: 'focus', title: '오늘의 핵심', items: focus.map((x) => (x.due < t ? `${todoLine(x)} — ${diffDays(t, x.due)}일 지연` : todoLine(x))) });
  }
  sections.push({ key: 'events', title: '오늘 일정', items: todayEvents.map(eventLine), empty: '예정된 일정이 없습니다.' });
  sections.push({ key: 'todos', title: '오늘 할 일', items: todayTodos.map(todoLine), empty: '오늘 마감인 할 일이 없습니다.' });
  if (overdue.length) {
    sections.push({
      key: 'overdue', title: '미완료 항목',
      items: overdue.map((x) => `${x.title} — ${diffDays(t, x.due)}일 지연${x.postponed ? `, ${x.postponed}번 미룸` : ''}`),
    });
  }
  if (upcoming.length) {
    sections.push({ key: 'upcoming', title: '이번 주 다가오는 마감', items: upcoming.map((x) => `${formatRelative(x.due, t)} · ${todoLine(x)}`) });
  }
  if (upcomingEvents.length) {
    sections.push({ key: 'nextEvents', title: '앞으로 3일 일정', items: upcomingEvents.map((e) => `${formatRelative(e.date, t)} · ${eventLine(e)}`) });
  }
  if (doneYesterday.length) {
    sections.push({ key: 'done', title: '어제 완료', items: doneYesterday.map((x) => x.title) });
  }
  if (techBrief) {
    const firstLine = techBrief.body.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
    sections.push({
      key: 'tech', title: '최근 기술 브리핑', memoId: techBrief.id,
      items: [`${techBrief.title || '(제목 없음)'}${firstLine ? ` — ${firstLine.slice(0, 80)}` : ''}`],
    });
  }

  const md = [`# ${formatLong(t)} 브리핑`, '', headline, ''];
  sections.forEach((sec) => {
    md.push(`## ${sec.title}`);
    if (sec.items.length) sec.items.forEach((i) => md.push(`- ${i}`));
    else md.push(`- ${sec.empty}`);
    md.push('');
  });

  return {
    date: t,
    headline,
    sections,
    markdown: `${md.join('\n').trimEnd()}\n`,
    stats: {
      todayTodos: todayTodos.length,
      doneToday: doneToday.length,
      overdue: overdue.length,
      todayEvents: todayEvents.length,
      noDate: noDate.length,
    },
  };
}
