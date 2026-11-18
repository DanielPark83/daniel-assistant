// 기기 간 동기화.
// GitHub 비공개 저장소의 JSON 파일(data/assistant.json) 하나를 모든 기기가 함께 읽고 쓴다.
//  - 읽기: 원격 파일을 받아 이 기기의 데이터와 병합(store.applySnapshot)
//  - 쓰기: 병합 결과가 원격과 다르면 파일의 sha를 조건으로 덮어쓴다.
//          그사이 다른 기기가 먼저 썼다면(409/422) 다시 읽어 병합한 뒤 재시도한다.
// GitHub 토큰은 이 기기의 localStorage에만 저장되며 데이터 파일에는 들어가지 않는다.

import * as store from './store.js';
import { utf8ToBase64, base64ToUtf8, bytesToB64url, b64urlToBytes } from './b64.js';

const CONFIG_KEY = 'daniel-assistant.sync';
const DEVICE_KEY = 'daniel-assistant.device';
const API_OVERRIDE_KEY = 'daniel-assistant.sync-api'; // 테스트에서 가짜 서버를 쓰기 위한 값
export const DATA_PATH = 'data/assistant.json';

let storage = null;
let config = null; // { token, owner, repo, branch }
let status = { state: 'off', lastSyncAt: null, error: null };
const statusListeners = new Set();
let running = null;
let again = false;
let timer = null;
let lastVisibleSync = 0;

export class SyncError extends Error {
  constructor(message, kind = 'error', httpStatus = 0) {
    super(message);
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

// ───────── 설정 ─────────

function readJSON(key) {
  try { return JSON.parse(storage.getItem(key)); } catch { return null; }
}

function writeConfig(next) {
  config = next;
  try {
    if (next) storage.setItem(CONFIG_KEY, JSON.stringify(next));
    else storage.removeItem(CONFIG_KEY);
  } catch { /* 저장소를 못 쓰면 이번 실행 동안만 유지 */ }
}

export function isConnected() { return !!config; }
export function getConfig() { return config ? { owner: config.owner, repo: config.repo, branch: config.branch } : null; }
export function getStatus() { return { ...status }; }
export function onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }

function setStatus(fields) {
  status = { ...status, ...fields };
  if (status.lastSyncAt) {
    try { storage.setItem(`${CONFIG_KEY}.last`, status.lastSyncAt); } catch { /* 무시 */ }
  }
  statusListeners.forEach((fn) => fn(getStatus()));
}

export function deviceId() {
  let id = null;
  try { id = storage.getItem(DEVICE_KEY); } catch { /* 무시 */ }
  if (!id || !/^[\w-]{4,64}$/.test(id)) {
    id = `d-${store.uid()}`;
    try { storage.setItem(DEVICE_KEY, id); } catch { /* 무시 */ }
  }
  return id;
}

export function deviceLabel(ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '')) {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android 폰' : 'Android 태블릿';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux PC';
  return '이 기기';
}

// ───────── GitHub API ─────────

function apiBase() {
  try { return storage.getItem(API_OVERRIDE_KEY) || 'https://api.github.com'; } catch { return 'https://api.github.com'; }
}

async function api(path, { method = 'GET', body, token = config && config.token } = {}) {
  let res;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new SyncError('인터넷에 연결되어 있지 않아 동기화를 미뤘습니다.', 'offline');
  }
  if (res.ok) return res.status === 204 ? null : res.json();

  const s = res.status;
  if (s === 401) throw new SyncError('GitHub 토큰이 올바르지 않거나 만료되었습니다. 새 토큰으로 다시 연결해 주세요.', 'auth', s);
  if (s === 403 || s === 429) {
    if (res.headers.get('x-ratelimit-remaining') === '0' || s === 429) {
      throw new SyncError('GitHub 요청 한도를 넘었습니다. 잠시 후 다시 시도합니다.', 'rate', s);
    }
    throw new SyncError('GitHub 토큰에 저장소 쓰기 권한(Contents: Read and write)이 없습니다.', 'auth', s);
  }
  if (s === 404) throw new SyncError('저장소나 파일을 찾을 수 없습니다.', 'notfound', s);
  if (s === 409 || s === 422) throw new SyncError('다른 기기와 동시에 저장해 충돌했습니다.', 'conflict', s);
  throw new SyncError(`GitHub 서버 오류(${s})로 동기화하지 못했습니다. 잠시 후 다시 시도합니다.`, 'server', s);
}

const repoPath = (c = config) => `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`;

// 토큰으로 쓸 수 있는 비공개 저장소 목록
export async function listRepos(token) {
  const list = await api('/user/repos?per_page=100&sort=updated', { token });
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && r.private && r.owner && (!r.permissions || r.permissions.push !== false))
    .map((r) => ({ owner: r.owner.login, repo: r.name, branch: r.default_branch || 'main', fullName: r.full_name }));
}

async function readRemote() {
  let file;
  try {
    file = await api(`${repoPath()}/contents/${DATA_PATH}?ref=${encodeURIComponent(config.branch)}`);
  } catch (err) {
    if (err.kind !== 'notfound') throw err;
    // 파일이 없는 것인지, 저장소에 접근할 수 없는 것인지 구분한다.
    await api(repoPath());
    return { sha: null, data: null };
  }
  let text;
  if (file && file.encoding === 'base64' && file.content) text = base64ToUtf8(file.content);
  else if (file && file.sha) text = base64ToUtf8((await api(`${repoPath()}/git/blobs/${file.sha}`)).content);
  else text = '';
  if (!text.trim()) return { sha: file.sha, data: null };
  try {
    return { sha: file.sha, data: JSON.parse(text) };
  } catch {
    throw new SyncError(`저장소의 ${DATA_PATH} 파일이 손상되어 읽을 수 없습니다.`, 'corrupt');
  }
}

async function writeRemote(snapshot, sha) {
  const body = {
    message: `데이터 동기화 (${deviceLabel()})`,
    content: utf8ToBase64(`${JSON.stringify(snapshot, null, 1)}\n`),
    branch: config.branch,
    ...(sha ? { sha } : {}),
  };
  try {
    await api(`${repoPath()}/contents/${DATA_PATH}`, { method: 'PUT', body });
    return true;
  } catch (err) {
    if (err.kind === 'conflict') return false;
    throw err;
  }
}

// ───────── 동기화 ─────────

async function syncOnce() {
  let lastConflict = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const remote = await readRemote();
    store.applySnapshot(remote.data);
    const local = store.syncSnapshot();
    if (remote.data && store.sameSnapshot(local, remote.data)) return;
    if (await writeRemote(local, remote.sha)) return;
    lastConflict = attempt;
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
  }
  throw new SyncError(`다른 기기와 저장이 계속 겹쳤습니다(${lastConflict + 1}회). 잠시 후 다시 시도합니다.`, 'conflict');
}

export function syncNow() {
  if (!config) return Promise.resolve(false);
  if (running) { again = true; return running; }
  clearTimeout(timer);
  timer = null;
  running = (async () => {
    setStatus({ state: 'syncing' });
    try {
      do { again = false; await syncOnce(); } while (again);
      setStatus({ state: 'idle', lastSyncAt: new Date().toISOString(), error: null });
      return true;
    } catch (err) {
      if (err.kind === 'offline') setStatus({ state: 'offline', error: err.message });
      else setStatus({ state: 'error', error: err.message || String(err) });
      if (!(err instanceof SyncError)) console.warn(err);
      return false;
    } finally {
      running = null;
    }
  })();
  return running;
}

export function scheduleSync(delay = 2000) {
  if (!config) return;
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; syncNow(); }, delay);
}

// 토큰을 확인하고 연결한다. 첫 동기화가 실패하면 연결하지 않은 상태로 되돌린다.
export async function connect({ token, owner, repo, branch }) {
  const prev = config;
  writeConfig({ token, owner, repo, branch: branch || 'main' });
  const ok = await syncNow();
  if (!ok && status.state === 'error') {
    const msg = status.error;
    writeConfig(prev);
    setStatus({ state: prev ? 'idle' : 'off', error: null });
    throw new SyncError(msg);
  }
  return ok;
}

export function disconnect() {
  clearTimeout(timer);
  writeConfig(null);
  setStatus({ state: 'off', error: null, lastSyncAt: null });
  try { storage.removeItem(`${CONFIG_KEY}.last`); } catch { /* 무시 */ }
}

// ───────── 다른 기기 연결 링크 ─────────

export function makeConnectLink(baseUrl) {
  if (!config) return '';
  const payload = { v: 1, t: config.token, o: config.owner, r: config.repo, b: config.branch };
  return `${baseUrl}#connect=${bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
}

// 링크 전체나 #connect= 뒷부분을 받아 연결 정보로 바꾼다. 형식이 틀리면 null.
export function parseConnectPayload(text) {
  const m = /(?:^|#connect=)([\w-]{20,})$/.exec(String(text || '').trim());
  if (!m) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlToBytes(m[1])));
    const ok = (v) => typeof v === 'string' && v.length > 0 && v.length < 200;
    if (p.v !== 1 || !ok(p.t) || !ok(p.o) || !ok(p.r) || !ok(p.b)) return null;
    if (!/^[\w.-]+$/.test(p.o) || !/^[\w.-]+$/.test(p.r) || !/^[\w-]+$/.test(p.t)) return null;
    return { token: p.t, owner: p.o, repo: p.r, branch: p.b };
  } catch {
    return null;
  }
}

// ───────── 시작 ─────────

export function init(storageImpl) {
  storage = storageImpl || { getItem: () => null, setItem() {}, removeItem() {} };
  const c = readJSON(CONFIG_KEY);
  config = c && c.token && c.owner && c.repo ? { token: c.token, owner: c.owner, repo: c.repo, branch: c.branch || 'main' } : null;
  let last = null;
  try { last = storage.getItem(`${CONFIG_KEY}.last`); } catch { /* 무시 */ }
  status = { state: config ? 'idle' : 'off', lastSyncAt: config ? last : null, error: null };
}

export function start() {
  // 이 기기에서 공유 데이터가 바뀌면 잠시 모았다가 올린다.
  store.subscribe((_, meta) => { if (meta.synced) scheduleSync(); });

  document.addEventListener('visibilitychange', () => {
    if (!config) return;
    if (document.hidden) {
      if (timer) syncNow(); // 앱을 닫기 전에 남은 변경을 바로 올린다
    } else if (Date.now() - lastVisibleSync > 15000) {
      lastVisibleSync = Date.now();
      syncNow();
    }
  });
  window.addEventListener('online', () => syncNow());
  setInterval(() => { if (config && !document.hidden) syncNow(); }, 5 * 60 * 1000);

  if (config) {
    lastVisibleSync = Date.now();
    syncNow();
  }
}
