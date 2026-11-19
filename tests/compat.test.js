import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as store from '../js/store.js';
import * as sync from '../js/sync.js';
import { utf8ToBase64 } from '../js/b64.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
}

const T = '2026-11-19T01:00:00.000Z';

beforeEach(() => { store.init(memoryStorage()); });

test('배포 버전이 한곳에서 일치한다(index.html의 모든 스크립트 주소 = version.json)', () => {
  const { version } = JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8'));
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const stamps = [...html.matchAll(/\?v=([\w.-]+)/g)].map((m) => m[1]);
  assert.ok(stamps.length >= 10, '모든 모듈이 버전 주소를 쓴다');
  assert.deepEqual([...new Set(stamps)], [version]);
  // 모든 앱 모듈이 import map에 들어 있어야 옛 파일이 섞이지 않는다
  const modules = readdirSync(new URL('../js/', import.meta.url)).filter((f) => f.endsWith('.js'));
  modules.forEach((f) => assert.ok(html.includes(`"./js/${f}": "./js/${f}?v=${version}"`), `import map에 ${f}`));
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /cache: 'no-cache'/, '서비스 워커가 매번 서버에 확인한다');
});

test('새 버전 앱이 추가한 필드와 데이터는 옛 버전 기기를 거쳐도 남는다', () => {
  const fromNewerApp = {
    format: 1,
    todos: [{ id: 't1', title: '할 일', createdAt: T, updatedAt: T, project: 'p1', subtasks: [{ title: '하위', done: false }] }],
    memos: [{ id: 'm1', title: '메모', createdAt: T, updatedAt: T, color: 'yellow' }],
    projects: [{ id: 'p1', name: '분기 보고' }],
  };
  // 옛 버전 기기: 받은 데이터를 반영하고 자기 변경을 더해 다시 올린다
  store.applySnapshot(fromNewerApp);
  store.addTodo({ title: '옛 기기에서 추가' });
  const uploaded = store.syncSnapshot();
  const t1 = uploaded.todos.find((t) => t.id === 't1');
  assert.equal(t1.project, 'p1');
  assert.deepEqual(t1.subtasks, [{ title: '하위', done: false }]);
  assert.equal(uploaded.memos[0].color, 'yellow');
  assert.deepEqual(uploaded.projects, [{ id: 'p1', name: '분기 보고' }]);
  assert.equal(uploaded.todos.length, 2);
  // 기기에 저장했다가 다시 열어도 남는다
  const reopened = store.normalize(JSON.parse(JSON.stringify(store.getState())));
  assert.deepEqual(store.syncSnapshot(reopened).projects, [{ id: 'p1', name: '분기 보고' }]);
  // 이 기기에서 고친 항목도 새 필드를 잃지 않는다
  store.updateTodo('t1', { title: '고친 제목' });
  assert.equal(store.syncSnapshot().todos.find((t) => t.id === 't1').project, 'p1');
});

test('병합할 때도 모르는 최상위 데이터를 보존한다', () => {
  const merged = store.mergeSnapshots({ todos: [] }, { todos: [], projects: [{ id: 'p' }], format: 1 });
  assert.deepEqual(merged.projects, [{ id: 'p' }]);
  assert.equal(merged.format, 1);
});

test('옛 버전 앱은 더 새 형식의 동기화 파일을 덮어쓰지 않는다', async () => {
  const storage = memoryStorage();
  storage.setItem('daniel-assistant.sync', JSON.stringify({ token: 'github_pat_x', owner: 'me', repo: 'data', branch: 'main' }));
  sync.init(storage);
  const calls = [];
  const remote = { format: store.SYNC_FORMAT + 1, todos: [] };
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${url}`);
    return new Response(JSON.stringify({ sha: 'abc', encoding: 'base64', content: utf8ToBase64(JSON.stringify(remote)) }), { status: 200 });
  };
  store.addTodo({ title: '로컬 할 일' });
  const ok = await sync.syncNow();
  assert.equal(ok, false);
  assert.equal(sync.getStatus().state, 'error');
  assert.match(sync.getStatus().error, /새 버전/);
  assert.ok(calls.every((c) => c.startsWith('GET')), '쓰기 요청을 보내지 않는다');
  assert.equal(store.getState().todos.length, 1, '이 기기의 데이터도 그대로');
  delete globalThis.fetch;
});
