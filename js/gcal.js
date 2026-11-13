// Google Calendar 읽기 전용 연동 (Google Identity Services 토큰 방식).
// 설정 화면에 입력한 OAuth 클라이언트 ID로 브라우저에서 직접 인증하며, 서버를 거치지 않는다.
// 액세스 토큰은 탭이 열려 있는 동안만 sessionStorage에 보관한다(약 1시간 유효).

import { toISODate, addDays } from './dates.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_KEY = 'daniel-assistant.gcal-token';

let gisPromise = null;

function loadGis() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GIS_SRC;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => { gisPromise = null; reject(new Error('Google 로그인 스크립트를 불러오지 못했습니다. 네트워크를 확인해 주세요.')); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

// 로그인 팝업이 차단되지 않도록 스크립트를 미리 불러 둔다.
export function preload() { return loadGis(); }

export function savedToken() {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const tok = JSON.parse(raw);
    return tok.expiresAt > Date.now() + 30000 ? tok.accessToken : null;
  } catch {
    return null;
  }
}

export function isConnected() { return !!savedToken(); }

// 반드시 사용자 탭(클릭) 안에서 호출해야 팝업이 차단되지 않는다.
export async function connect(clientId) {
  if (!clientId) throw new Error('먼저 Google OAuth 클라이언트 ID를 입력해 주세요.');
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) { reject(new Error(`Google 인증 실패: ${resp.error_description || resp.error}`)); return; }
        const expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ accessToken: resp.access_token, expiresAt })); } catch { /* 무시 */ }
        resolve(resp.access_token);
      },
      error_callback: (err) => reject(new Error(err && err.type === 'popup_closed' ? '로그인 창이 닫혔습니다.' : 'Google 로그인 창을 열지 못했습니다.')),
    });
    client.requestAccessToken();
  });
}

export function disconnect() {
  const token = savedToken();
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* 무시 */ }
  if (token && window.google && window.google.accounts) {
    window.google.accounts.oauth2.revoke(token, () => {});
  }
}

async function api(path, params, token) {
  const url = new URL(`${API}${path}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* 무시 */ }
    throw new Error('Google 연결이 만료되었습니다. 다시 연결해 주세요.');
  }
  if (!res.ok) throw new Error(`Google Calendar 요청 실패 (${res.status})`);
  return res.json();
}

// Google 일정 한 건을 앱의 일정 형태로 바꾼다.
export function normalizeEvent(item, cal) {
  if (!item || item.status === 'cancelled' || !item.start) return null;
  const allDay = !!item.start.date;
  let date; let time = null; let endDate; let endTime = null;
  if (allDay) {
    date = item.start.date;
    // 종일 일정의 종료일은 '다음 날'로 오므로 하루를 뺀다
    endDate = item.end && item.end.date ? addDays(item.end.date, -1) : date;
    if (endDate < date) endDate = date;
  } else {
    const start = new Date(item.start.dateTime);
    const end = item.end && item.end.dateTime ? new Date(item.end.dateTime) : start;
    const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    date = toISODate(start);
    time = hm(start);
    endDate = toISODate(end);
    endTime = hm(end);
    // 자정에 끝나는 일정은 전날까지로 본다
    if (endDate > date && endTime === '00:00') endDate = addDays(endDate, -1);
  }
  return {
    id: `g:${cal.id}:${item.id}`,
    title: item.summary || '(제목 없음)',
    date, time, endDate, endTime, allDay,
    location: item.location || '',
    calendar: cal.summary || '',
    link: item.htmlLink || '',
  };
}

// 지난 7일 ~ 앞으로 60일 일정을 모든 표시 중인 캘린더에서 가져온다.
export async function fetchEvents(now = new Date()) {
  const token = savedToken();
  if (!token) throw new Error('Google Calendar가 연결되어 있지 않습니다.');
  const t = toISODate(now);
  const timeMin = new Date(`${addDays(t, -7)}T00:00:00`).toISOString();
  const timeMax = new Date(`${addDays(t, 60)}T23:59:59`).toISOString();

  const list = await api('/users/me/calendarList', { minAccessRole: 'reader', maxResults: '100' }, token);
  const calendars = (list.items || []).filter((c) => c.selected !== false && !c.hidden);
  const events = [];
  await Promise.all(calendars.map(async (cal) => {
    let pageToken = '';
    for (let page = 0; page < 5; page += 1) {
      const params = { singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax, maxResults: '250' };
      if (pageToken) params.pageToken = pageToken;
      // eslint-disable-next-line no-await-in-loop
      const data = await api(`/calendars/${encodeURIComponent(cal.id)}/events`, params, token);
      (data.items || []).forEach((item) => {
        const ev = normalizeEvent(item, cal);
        if (ev) events.push(ev);
      });
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    }
  }));
  return events;
}
