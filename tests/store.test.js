import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';
import { buildBriefing } from '../js/briefing.js';
import { parseMarkdownTasks, exportMarkdown, todoToMarkdown } from '../js/markdown.js';

// 기준 시각: 2026-11-13(금) 10:00
const NOW = new Date(2026, 10, 13, 10, 0);

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
}

beforeEach(() => { store.init(memoryStorage()); });

test('저장소에 기록하고 다시 읽는다', () => {
  const mem = memoryStorage();
  store.init(mem);
  store.addTodo({ title: '보고서', due: '2026-11-13', priority: 'high' });
  store.addMemo({ title: '메모', body: '내용', tags: ['기획'] });
  const loaded = store.init(mem);
  assert.equal(loaded.todos.length, 1);
  assert.equal(loaded.todos[0].title, '보고서');
  assert.equal(loaded.memos[0].tags[0], '기획');
});

test('지연·오늘 할 일 조회와 정렬', () => {
  store.addTodo({ title: '낮음', due: '2026-11-13', priority: 'low' });
  store.addTodo({ title: '높음', due: '2026-11-13', priority: 'high' });
  store.addTodo({ title: '지연', due: '2026-11-10' });
  store.addTodo({ title: '날짜 없음' });
  const s = store.getState();
  assert.deepEqual(store.todosDueOn(s, '2026-11-13').map((t) => t.title), ['높음', '낮음']);
  assert.deepEqual(store.overdueTodos(s, '2026-11-13').map((t) => t.title), ['지연']);
});

test('미루기는 횟수와 원래 마감일을 기록한다', () => {
  const t = store.addTodo({ title: '견적서', due: '2026-11-10' });
  store.postponeTodo(t.id, '2026-11-13');
  store.postponeTodo(t.id, '2026-11-14');
  const got = store.getState().todos[0];
  assert.equal(got.due, '2026-11-14');
  assert.equal(got.postponed, 2);
  assert.equal(got.originalDue, '2026-11-10');
});

test('반복 할 일을 완료하면 다음 회차가 생긴다', () => {
  const daily = store.addTodo({ title: '운동', due: '2026-11-13', repeat: 'daily' });
  const r1 = store.toggleTodo(daily.id, NOW);
  assert.equal(r1.todo.done, true);
  assert.equal(r1.spawned.due, '2026-11-14');
  assert.equal(r1.spawned.repeat, 'daily');

  // 지연된 주간 반복은 원래 요일(월요일)을 유지해 다음 주로 넘어간다
  const weekly = store.addTodo({ title: '주간 보고', due: '2026-11-02', repeat: 'weekly' });
  assert.equal(store.toggleTodo(weekly.id, NOW).spawned.due, '2026-11-16');

  const monthly = store.addTodo({ title: '월세', due: '2026-10-31', repeat: 'monthly' });
  assert.equal(store.toggleTodo(monthly.id, NOW).spawned.due, '2026-11-30');

  // 완료를 취소했다가 다시 완료해도 회차가 중복 생성되지 않는다
  const before = store.getState().todos.length;
  store.toggleTodo(daily.id, NOW);
  store.toggleTodo(daily.id, NOW);
  assert.equal(store.getState().todos.length, before);
});

test('중요 알림: 지연, 중요 마감, 곧 시작하는 일정', () => {
  store.addTodo({ title: '지연된 일', due: '2026-11-11' });
  store.addTodo({ title: '내일 중요', due: '2026-11-14', priority: 'high' });
  store.addTodo({ title: '내일 보통', due: '2026-11-14' });
  store.addEvent({ title: '곧 회의', date: '2026-11-13', time: '10:30' });
  store.addEvent({ title: '오후 회의', date: '2026-11-13', time: '15:00' });
  const list = store.alerts(store.getState(), NOW);
  assert.deepEqual(list.map((a) => [a.text, a.detail]), [
    ['곧 회의', '30분 후 시작'],
    ['지연된 일', '2일 지연'],
    ['내일 중요', '내일 마감 · 중요'],
  ]);
});

test('날짜별 일정 조회', () => {
  store.addEvent({ title: '점심', date: '2026-11-13', time: '12:00' });
  store.addEvent({ title: '종일 워크숍', date: '2026-11-13' });
  store.addEvent({ title: '치과', date: '2026-11-16', time: '18:30' });
  const s = store.getState();
  assert.deepEqual(store.eventsOn(s, '2026-11-13').map((e) => e.title), ['종일 워크숍', '점심']);
  assert.deepEqual(store.eventsOn(s, '2026-11-15').map((e) => e.title), []);
  assert.equal(store.eventsBetween(s, '2026-11-14', '2026-11-20').length, 1);
});

test('메모 검색: 제목·내용·태그, 여러 단어는 모두 포함', () => {
  store.addMemo({ title: '온보딩 개선', body: '체크리스트를 줄인다', tags: ['기획'] });
  store.addMemo({ title: '장보기', body: '우유 계란', tags: ['개인'] });
  const s = store.getState();
  assert.equal(store.searchMemos(s, '체크리스트').length, 1);
  assert.equal(store.searchMemos(s, '#기획').length, 1);
  assert.equal(store.searchMemos(s, '온보딩 우유').length, 0);
  assert.equal(store.searchMemos(s, '', '개인')[0].title, '장보기');
  assert.equal(store.searchMemos(s, '').length, 2);
});

test('브리핑 요약', () => {
  store.addTodo({ title: '보고서 제출', due: '2026-11-13', time: '15:00', priority: 'high' });
  store.addTodo({ title: '견적서 회신', due: '2026-11-11' });
  store.addTodo({ title: '다음 주 일', due: '2026-11-17' });
  store.addEvent({ title: '로드맵 회의', date: '2026-11-13', time: '10:30', location: '회의실 B' });
  store.addMemo({ title: '주간 기술 브리핑', body: '요약 한 줄\n둘째 줄', tags: [store.BRIEFING_TAG] });
  const b = buildBriefing(store.getState(), NOW);
  assert.equal(b.headline, '일정 1건, 오늘 할 일 1건, 미완료 1건 이월.');
  assert.deepEqual(b.sections.map((s) => s.key), ['focus', 'events', 'todos', 'overdue', 'upcoming', 'tech']);
  assert.equal(b.sections[0].items[0], '보고서 제출 (오후 3시) · 중요');
  assert.match(b.markdown, /^# 11월 13일 금요일 브리핑/);
  assert.match(b.markdown, /- 오전 10:30 로드맵 회의 · 회의실 B/);
});

test('마크다운 체크리스트 가져오기·내보내기', () => {
  const todos = parseMarkdownTasks([
    '# 할 일 마스터',
    '- [ ] 모레까지 계약서 검토 #업무',
    '- [x] 완료된 일 ✅ 2026-11-12',
    '* [ ] 릴리스 노트 작성 ⏫ 📅 2026-11-20 🔁 every week',
    '일반 문장은 무시',
  ].join('\n'), NOW);
  assert.equal(todos.length, 3);
  assert.deepEqual([todos[0].title, todos[0].due, todos[0].tags], ['계약서 검토', '2026-11-15', ['업무']]);
  assert.equal(todos[1].done, true);
  assert.deepEqual([todos[2].title, todos[2].due, todos[2].priority, todos[2].repeat], ['릴리스 노트 작성', '2026-11-20', 'high', 'weekly']);

  store.mergeTodos(todos);
  const md = exportMarkdown(store.getState());
  assert.match(md, /- \[ \] 릴리스 노트 작성 ⏫ 🔁 every week 📅 2026-11-20/);
  assert.match(md, /- \[x\] 완료된 일/);
  // 내보낸 줄을 다시 읽으면 같은 값이 나온다
  const round = parseMarkdownTasks(todoToMarkdown(store.getState().todos[2]), NOW)[0];
  assert.deepEqual([round.title, round.due, round.priority, round.repeat], ['릴리스 노트 작성', '2026-11-20', 'high', 'weekly']);
});

test('손상된 백업 데이터는 안전한 형태로 맞춘다', () => {
  const s = store.normalize({
    todos: [{ title: 'ok', due: 'not-a-date', priority: 'x', tags: 'bad' }, null, 'str'],
    events: [{ title: '날짜 없음' }, { title: '정상', date: '2026-11-13', time: '9시' }],
    settings: { theme: 'neon', name: '' },
  });
  assert.equal(s.todos.length, 1);
  assert.deepEqual([s.todos[0].due, s.todos[0].priority, s.todos[0].tags], [null, 'medium', []]);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].time, null);
  assert.deepEqual([s.settings.theme, s.settings.name], ['auto', 'Daniel']);
  assert.deepEqual(store.normalize(null).todos, []);
});
