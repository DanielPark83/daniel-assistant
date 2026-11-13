// 날짜 유틸리티. 모든 날짜는 기기 현지 시간 기준 'YYYY-MM-DD' 문자열로 다룬다.

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const pad = (n) => String(n).padStart(2, '0');

export function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function today(now = new Date()) {
  return toISODate(now);
}

export function addDays(iso, n) {
  const d = fromISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

export function addMonths(iso, n) {
  const d = fromISODate(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toISODate(d);
}

// a - b 를 일 단위로 반환
export function diffDays(a, b) {
  return Math.round((fromISODate(a) - fromISODate(b)) / 86400000);
}

export function weekdayOf(iso) {
  return fromISODate(iso).getDay();
}

// 월요일 시작 기준 해당 주의 월요일
export function startOfWeek(iso) {
  const wd = weekdayOf(iso);
  return addDays(iso, -((wd + 6) % 7));
}

export function endOfMonth(iso) {
  const d = fromISODate(iso);
  return toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

export function formatLong(iso) {
  const d = fromISODate(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`;
}

export function formatShort(iso) {
  const d = fromISODate(iso);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
}

// 오늘 기준 상대 표현: 오늘, 내일, 어제, 3일 지연, 11/20(금) ...
export function formatRelative(iso, todayIso = today()) {
  const diff = diffDays(iso, todayIso);
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  if (diff === 2) return '모레';
  if (diff === -1) return '어제';
  return formatShort(iso);
}

export function formatTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h < 12 ? '오전' : '오후';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${ampm} ${h12}시` : `${ampm} ${h12}:${pad(m)}`;
}

export function nowHHMM(now = new Date()) {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export { WEEKDAYS, pad };
