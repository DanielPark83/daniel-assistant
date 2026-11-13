// 마크다운 체크리스트 가져오기·내보내기 (Obsidian Tasks 형식과 호환).
//   - [ ] 분기 보고서 제출 ⏫ 📅 2026-11-14 #업무

import { parseQuickInput } from './nlp.js';
import { compareTodos } from './store.js';

const REPEAT_TEXT = { daily: 'every day', weekly: 'every week', monthly: 'every month' };

export function parseMarkdownTasks(md, now = new Date()) {
  const todos = [];
  String(md || '').split(/\r?\n/).forEach((line) => {
    const m = /^\s*(?:[-*+]|\d+\.)\s+\[( |x|X)\]\s+(.+)$/.exec(line);
    if (!m) return;
    let text = m[2];
    const fields = {};

    const due = /📅\s*(\d{4}-\d{2}-\d{2})/.exec(text);
    if (due) { fields.due = due[1]; text = text.replace(due[0], ' '); }
    const done = /✅\s*(\d{4}-\d{2}-\d{2})/.exec(text);
    if (done) text = text.replace(done[0], ' ');
    const time = /⏰\s*(\d{2}:\d{2})/.exec(text);
    if (time) { fields.time = time[1]; text = text.replace(time[0], ' '); }
    const rep = /🔁\s*every\s+(day|week|month)/i.exec(text);
    if (rep) {
      fields.repeat = { day: 'daily', week: 'weekly', month: 'monthly' }[rep[1].toLowerCase()];
      text = text.replace(rep[0], ' ');
    }
    if (/[🔺⏫🔼]/u.test(text)) fields.priority = 'high';
    else if (/[🔽⏬]/u.test(text)) fields.priority = 'low';
    text = text.replace(/[🔺⏫🔼🔽⏬]/gu, ' ');
    // 그 밖의 Tasks 날짜 표기(시작·예정·생성일)는 버린다
    text = text.replace(/[🛫⏳➕]\s*\d{4}-\d{2}-\d{2}/gu, ' ');

    // 남은 문장은 자연어로 해석한다 (예: "- [ ] 내일까지 견적서 회신")
    const parsed = parseQuickInput(text, now);
    const todo = { ...parsed, ...fields };
    if (!todo.title) return;
    if (m[1] !== ' ') {
      todo.done = true;
      todo.doneAt = (done ? new Date(`${done[1]}T12:00:00`) : now).toISOString();
      todo.repeat = null;
    }
    todos.push(todo);
  });
  return todos;
}

export function todoToMarkdown(t) {
  const parts = [`- [${t.done ? 'x' : ' '}] ${t.title}`];
  if (t.tags.length) parts.push(t.tags.map((x) => `#${x}`).join(' '));
  if (t.priority === 'high') parts.push('⏫');
  if (t.priority === 'low') parts.push('🔽');
  if (t.repeat) parts.push(`🔁 ${REPEAT_TEXT[t.repeat]}`);
  if (t.due) parts.push(`📅 ${t.due}`);
  if (t.time) parts.push(`⏰ ${t.time}`);
  if (t.done && t.doneAt) parts.push(`✅ ${t.doneAt.slice(0, 10)}`);
  return parts.join(' ');
}

export function exportMarkdown(state) {
  const open = state.todos.filter((t) => !t.done).sort(compareTodos);
  const done = state.todos.filter((t) => t.done).sort(compareTodos);
  const lines = ['# 할 일 마스터', '', '## 진행 중', ''];
  lines.push(...(open.length ? open.map(todoToMarkdown) : ['(없음)']));
  lines.push('', '## 완료', '');
  lines.push(...(done.length ? done.map(todoToMarkdown) : ['(없음)']));
  if (state.memos.length) {
    lines.push('', '# 메모', '');
    [...state.memos].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).forEach((m) => {
      lines.push(`## ${m.title || '(제목 없음)'}`, '');
      if (m.tags.length) lines.push(m.tags.map((x) => `#${x}`).join(' '), '');
      if (m.body) lines.push(m.body, '');
    });
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
