// 한국어 자연어 빠른 입력 파서.
// 예) "내일 오후 3시 분기 보고서 제출 !중요 #업무"
//  -> { title: '분기 보고서 제출', due: '내일 날짜', time: '15:00', priority: 'high', tags: ['업무'] }

import { toISODate, addDays, addMonths, startOfWeek, endOfMonth, diffDays, pad } from './dates.js';

const DATE_P = '(?:까지|부터|안에|내로|에|중)?';
const TIME_P = '(?:까지|부터|에)?';
const WEEK_IDX = { 월: 0, 화: 1, 수: 2, 목: 3, 금: 4, 토: 5, 일: 6 };
const AM_WORDS = ['오전', '아침', '새벽'];

function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return toISODate(dt);
}

export function parseQuickInput(raw, now = new Date()) {
  const todayIso = toISODate(now);
  const out = { title: '', due: null, time: null, priority: 'medium', tags: [], repeat: null };
  const s = { text: ` ${String(raw || '').replace(/\s+/g, ' ').trim()} ` };

  // 매치된 구간을 공백으로 치환한다. handler가 false를 반환하면 소비하지 않는다.
  const take = (re, handler) => {
    const m = re.exec(s.text);
    if (!m) return false;
    if (handler(m) === false) return false;
    s.text = `${s.text.slice(0, m.index)} ${s.text.slice(m.index + m[0].length)}`;
    return true;
  };

  // 1) 태그
  while (take(/\s#([^\s#]+)(?=\s)/, (m) => { if (!out.tags.includes(m[1])) out.tags.push(m[1]); })) { /* 반복 */ }

  // 2) 중요도
  const setPriority = (p) => () => { out.priority = p; };
  take(/\s!(높음|중요|긴급|상)(?=\s)/, setPriority('high'))
    || take(/\s!(보통|중)(?=\s)/, setPriority('medium'))
    || take(/\s!(낮음|하)(?=\s)/, setPriority('low'))
    || take(/\s[pP]([123])(?=\s)/, (m) => { out.priority = ['high', 'medium', 'low'][m[1] - 1]; })
    || take(/\s!{1,3}(?=\s)/, setPriority('high'))
    || take(/!{2,}(?=\s)/, setPriority('high'))
    || take(/\s(긴급|중요|급함)(?=\s)/, setPriority('high'))
    || take(/\s(낮음|나중에)(?=\s)/, setPriority('low'));

  // 3) 반복
  take(/\s(매일|매주|매월|매달)(?=\s)/, (m) => {
    out.repeat = { 매일: 'daily', 매주: 'weekly', 매월: 'monthly', 매달: 'monthly' }[m[1]];
  });

  // 4) 시간
  const setTime = (h, min, meridiem) => {
    if (min > 59 || h > 24) return false;
    if (meridiem) {
      if (AM_WORDS.includes(meridiem)) { if (h === 12) h = 0; }
      else if (meridiem === '밤' && h === 12) h = 0;
      else if (h < 12) h += 12;
    } else if (h >= 1 && h <= 6) {
      h += 12; // 수식어 없는 1~6시는 오후로 본다
    }
    if (h > 23) return false;
    out.time = `${pad(h)}:${pad(min)}`;
    return true;
  };
  take(new RegExp(`\\s(오전|오후)?\\s?(\\d{1,2}):(\\d{2})${TIME_P}(?=\\s)`), (m) => setTime(+m[2], +m[3], m[1]))
    || take(new RegExp(`\\s(오전|오후|아침|점심|저녁|밤|새벽|낮)?\\s?(\\d{1,2})시\\s?(?:(반)|(\\d{1,2})분)?${TIME_P}(?=\\s)`),
      (m) => setTime(+m[2], m[3] ? 30 : +(m[4] || 0), m[1]))
    || take(new RegExp(`\\s정오${TIME_P}(?=\\s)`), () => { out.time = '12:00'; })
    || take(new RegExp(`\\s자정${TIME_P}(?=\\s)`), () => { out.time = '00:00'; });

  // 5) 날짜
  const setDue = (iso) => { if (!iso) return false; out.due = iso; return true; };
  const year = now.getFullYear();
  const thisWeekMon = startOfWeek(todayIso);

  take(new RegExp(`\\s(\\d{4})[-./](\\d{1,2})[-./](\\d{1,2})${DATE_P}(?=\\s)`), (m) => setDue(validDate(+m[1], +m[2], +m[3])))
    || take(new RegExp(`\\s(?:(\\d{4})년\\s?)?(\\d{1,2})월\\s?(\\d{1,2})일${DATE_P}(?=\\s)`), (m) => {
      if (m[1]) return setDue(validDate(+m[1], +m[2], +m[3]));
      let iso = validDate(year, +m[2], +m[3]);
      // 두 달 넘게 지난 날짜는 내년으로 본다
      if (iso && diffDays(iso, todayIso) < -60) iso = validDate(year + 1, +m[2], +m[3]);
      return setDue(iso);
    })
    || take(new RegExp(`\\s(\\d{1,2})/(\\d{1,2})${DATE_P}(?=\\s)`), (m) => {
      let iso = validDate(year, +m[1], +m[2]);
      if (iso && diffDays(iso, todayIso) < -60) iso = validDate(year + 1, +m[1], +m[2]);
      return setDue(iso);
    })
    || take(new RegExp(`\\s(?:(이번|다음|다다음)\\s?주\\s?)?([월화수목금토일])요일${DATE_P}(?=\\s)`), (m) => {
      const idx = WEEK_IDX[m[2]];
      if (m[1]) {
        const weeks = { 이번: 0, 다음: 1, 다다음: 2 }[m[1]];
        return setDue(addDays(thisWeekMon, weeks * 7 + idx));
      }
      const todayIdx = diffDays(todayIso, thisWeekMon);
      return setDue(addDays(todayIso, (idx - todayIdx + 7) % 7));
    })
    || take(new RegExp(`\\s(오늘|내일모레|내일|모레|글피)${DATE_P}(?=\\s)`), (m) =>
      setDue(addDays(todayIso, { 오늘: 0, 내일: 1, 내일모레: 2, 모레: 2, 글피: 3 }[m[1]])))
    || take(new RegExp(`\\s(\\d{1,3})\\s?(일|주일|주|개월|달)\\s?(?:후|뒤)${DATE_P}(?=\\s)`), (m) => {
      const n = +m[1];
      if (m[2] === '일') return setDue(addDays(todayIso, n));
      if (m[2] === '주' || m[2] === '주일') return setDue(addDays(todayIso, n * 7));
      return setDue(addMonths(todayIso, n));
    })
    || take(new RegExp(`\\s일주일\\s?(?:후|뒤)${DATE_P}(?=\\s)`), () => setDue(addDays(todayIso, 7)))
    || take(new RegExp(`\\s(이번|다음)\\s?주말${DATE_P}(?=\\s)`), (m) => {
      const sat = addDays(thisWeekMon, 5 + (m[1] === '다음' ? 7 : 0));
      // 이미 일요일이면 오늘을 기준으로 한다
      return setDue(m[1] === '이번' && diffDays(sat, todayIso) < 0 ? todayIso : sat);
    })
    || take(new RegExp(`\\s(이번|다음)\\s?주${DATE_P}(?=\\s)`), (m) => {
      if (m[1] === '다음') return setDue(addDays(thisWeekMon, 7));
      const fri = addDays(thisWeekMon, 4);
      return setDue(diffDays(fri, todayIso) < 0 ? todayIso : fri);
    })
    || take(new RegExp(`\\s(?:이번\\s?달\\s?말|월말)${DATE_P}(?=\\s)`), () => setDue(endOfMonth(todayIso)))
    || take(new RegExp(`\\s(\\d{1,2})일${DATE_P}(?=\\s)`), (m) => {
      let iso = validDate(year, now.getMonth() + 1, +m[1]);
      if (iso && diffDays(iso, todayIso) < 0) {
        const next = addMonths(`${todayIso.slice(0, 8)}01`, 1);
        iso = validDate(+next.slice(0, 4), +next.slice(5, 7), +m[1]);
      }
      return setDue(iso);
    });

  // 시간만 있으면 오늘(이미 지난 시각이면 내일), 반복만 있으면 오늘부터
  if (!out.due && out.time) {
    const nowHM = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    out.due = out.time > nowHM ? todayIso : addDays(todayIso, 1);
  }
  if (!out.due && out.repeat) out.due = todayIso;

  out.title = s.text.replace(/\s+/g, ' ').trim().replace(/^[,.\-·:]+\s*|\s*[,\-·:]+$/g, '').trim();
  return out;
}
