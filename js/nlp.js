// 한국어 자연어 빠른 입력 파서.
// 예) "내일 오후 3시 분기 보고서 제출 !중요 #업무"
//  -> { title: '분기 보고서 제출', due: '내일 날짜', time: '15:00', priority: 'high', tags: ['업무'] }

import { toISODate, addDays, addMonths, startOfWeek, endOfMonth, diffDays, pad } from './dates.js';

const DATE_P = '(?:까지|부터|안에|내로|에서|에|중)?';
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
  const out = { title: '', due: null, endDate: null, time: null, priority: 'medium', tags: [], repeat: null, remind: null };
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

  // 3-2) 알람 (시간보다 먼저: "1시간 전 알림"의 "1시"를 시각으로 읽지 않도록)
  const ALARM = '(?:알림|알람)';
  take(new RegExp(`\\s(\\d{1,3})\\s?(분|시간)\\s?전(?:에)?\\s?${ALARM}(?=\\s)`), (m) => {
    out.remind = +m[1] * (m[2] === '시간' ? 60 : 1);
    return out.remind <= 10080;
  })
    || take(new RegExp(`\\s${ALARM}\\s?(\\d{1,3})\\s?(분|시간)\\s?전(?=\\s)`), (m) => {
      out.remind = +m[1] * (m[2] === '시간' ? 60 : 1);
      return out.remind <= 10080;
    })
    || take(new RegExp(`\\s(?:하루|1일)\\s?전(?:에)?\\s?${ALARM}(?=\\s)`), () => { out.remind = 1440; })
    || take(new RegExp(`\\s(?:정시|제시간)\\s?${ALARM}(?=\\s)`), () => { out.remind = 0; });

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

  // 5) 날짜. 기간이면 시작일(due)과 종료일(endDate)을 함께 찾는다.
  //    예) "11월 20일~22일", "20일부터 22일까지", "내일부터 모레까지", "다음 주 월요일부터 수요일까지", "내일부터 3일간"
  const year = now.getFullYear();
  const thisWeekMon = startOfWeek(todayIso);
  const RANGE = '[~〜–—-]';

  // 연도 없이 쓴 월·일: 시작일은 두 달 넘게 지났으면 내년, 종료일은 시작일보다 앞이면 내년
  const monthDay = (m, d, base) => {
    const iso = validDate(+base.slice(0, 4) || year, +m, +d);
    if (!iso) return null;
    const rolled = validDate(+iso.slice(0, 4) + 1, +m, +d);
    if (base === todayIso) return diffDays(iso, todayIso) < -60 ? rolled : iso;
    // 종료일: 시작일보다 앞이면 내년(예: 12월 30일 ~ 1월 2일). 반년 넘게 벌어지면 잘못 쓴 것으로 본다
    return iso < base && rolled && diffDays(rolled, base) <= 180 ? rolled : iso;
  };
  // 날짜만 쓴 경우("22일"): 기준일이 있는 달, 이미 지났으면 다음 달
  const dayOnly = (d, base) => {
    let iso = validDate(+base.slice(0, 4), +base.slice(5, 7), +d);
    if (iso && iso < base) {
      const next = addMonths(`${base.slice(0, 8)}01`, 1);
      iso = validDate(+next.slice(0, 4), +next.slice(5, 7), +d);
    }
    return iso;
  };

  // 날짜 표현 하나를 찾아 문장에서 지우고 날짜를 돌려준다. base: 요일·날짜만 쓴 경우의 기준일
  const takeDate = (base = todayIso) => {
    let found = null;
    const set = (iso) => { if (!iso) return false; found = iso; return true; };
    take(new RegExp(`\\s(\\d{4})[-./](\\d{1,2})[-./](\\d{1,2})${DATE_P}(?=\\s)`), (m) => set(validDate(+m[1], +m[2], +m[3])))
      || take(new RegExp(`\\s(?:(\\d{4})년\\s?)?(\\d{1,2})월\\s?(\\d{1,2})일${DATE_P}(?=\\s)`), (m) =>
        set(m[1] ? validDate(+m[1], +m[2], +m[3]) : monthDay(m[2], m[3], base)))
      || take(new RegExp(`\\s(\\d{1,2})/(\\d{1,2})${DATE_P}(?=\\s)`), (m) => set(monthDay(m[1], m[2], base)))
      || take(new RegExp(`\\s(?:(이번|다음|다다음)\\s?주\\s?)?([월화수목금토일])요일${DATE_P}(?=\\s)`), (m) => {
        const idx = WEEK_IDX[m[2]];
        if (m[1]) return set(addDays(thisWeekMon, { 이번: 0, 다음: 1, 다다음: 2 }[m[1]] * 7 + idx));
        const baseIdx = diffDays(base, startOfWeek(base));
        return set(addDays(base, (idx - baseIdx + 7) % 7));
      })
      || take(new RegExp(`\\s(오늘|내일모레|내일|모레|글피)${DATE_P}(?=\\s)`), (m) =>
        set(addDays(todayIso, { 오늘: 0, 내일: 1, 내일모레: 2, 모레: 2, 글피: 3 }[m[1]])))
      || take(new RegExp(`\\s(\\d{1,3})\\s?(일|주일|주|개월|달)\\s?(?:후|뒤)${DATE_P}(?=\\s)`), (m) => {
        const n = +m[1];
        if (m[2] === '일') return set(addDays(todayIso, n));
        if (m[2] === '주' || m[2] === '주일') return set(addDays(todayIso, n * 7));
        return set(addMonths(todayIso, n));
      })
      || take(new RegExp(`\\s일주일\\s?(?:후|뒤)${DATE_P}(?=\\s)`), () => set(addDays(todayIso, 7)))
      || take(new RegExp(`\\s(이번|다음)\\s?주말${DATE_P}(?=\\s)`), (m) => {
        const sat = addDays(thisWeekMon, 5 + (m[1] === '다음' ? 7 : 0));
        // 이미 일요일이면 오늘을 기준으로 한다
        return set(m[1] === '이번' && diffDays(sat, todayIso) < 0 ? todayIso : sat);
      })
      || take(new RegExp(`\\s(이번|다음)\\s?주${DATE_P}(?=\\s)`), (m) => {
        if (m[1] === '다음') return set(addDays(thisWeekMon, 7));
        const fri = addDays(thisWeekMon, 4);
        return set(diffDays(fri, todayIso) < 0 ? todayIso : fri);
      })
      || take(new RegExp(`\\s(?:이번\\s?달\\s?말|월말)${DATE_P}(?=\\s)`), () => set(endOfMonth(todayIso)))
      || take(new RegExp(`\\s(\\d{1,2})일${DATE_P}(?=\\s)`), (m) => set(dayOnly(m[1], base)));
    return found;
  };

  const setRange = (from, to) => {
    if (!from) return false;
    out.due = from;
    if (to && to > from) out.endDate = to;
    return true;
  };

  // 줄여 쓴 기간: "20~22일", "11월 20일~22일", "11월 28일 ~ 12월 2일", "12/20~12/22"
  const shortRange = take(
    new RegExp(`\\s(?:(\\d{1,2})월\\s?)?(\\d{1,2})일?\\s?${RANGE}\\s?(?:(\\d{1,2})월\\s?)?(\\d{1,2})일${DATE_P}(?=\\s)`),
    (m) => {
      const from = m[1] ? monthDay(m[1], m[2], todayIso) : dayOnly(m[2], todayIso);
      const to = from && (m[3] ? monthDay(m[3], m[4], from) : dayOnly(m[4], from));
      return setRange(from, to);
    },
  ) || take(
    new RegExp(`\\s(\\d{1,2})/(\\d{1,2})\\s?${RANGE}\\s?(?:(\\d{1,2})/)?(\\d{1,2})${DATE_P}(?=\\s)`),
    (m) => {
      const from = monthDay(m[1], m[2], todayIso);
      const to = from && (m[3] ? monthDay(m[3], m[4], from) : dayOnly(m[4], from));
      return setRange(from, to);
    },
  );

  if (!shortRange) {
    const from = takeDate();
    if (from) {
      out.due = from;
      // "3일간", "3일 동안", "2박 3일", "일주일간" (날짜로 오해하지 않도록 먼저 찾는다)
      take(/\s(\d{1,2})박\s?(\d{1,2})일(?:간|\s?동안)?(?=\s)/, (m) => {
        if (+m[1] < 1) return false;
        out.endDate = addDays(from, +m[1]);
        return true;
      })
        || take(/\s(\d{1,2})일\s?(?:간|동안)(?=\s)/, (m) => {
          if (+m[1] < 2) return false;
          out.endDate = addDays(from, +m[1] - 1);
          return true;
        })
        || take(/\s일주일\s?(?:간|동안)(?=\s)/, () => { out.endDate = addDays(from, 6); return true; });
      // "A부터 B까지", "A ~ B": 두 번째 날짜는 시작일을 기준으로 해석한다
      if (!out.endDate && /부터|에서|[~〜–—]|\s-\s/.test(raw)) {
        const to = takeDate(from);
        if (to && to > from) out.endDate = to;
      }
    }
  }

  // 시간만 있으면 오늘(이미 지난 시각이면 내일), 반복만 있으면 오늘부터
  if (!out.due && out.time) {
    const nowHM = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    out.due = out.time > nowHM ? todayIso : addDays(todayIso, 1);
  }
  if (!out.due && out.repeat) out.due = todayIso;

  out.title = s.text.replace(/\s[~〜–—-]+(?=\s)/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[,.\-·:]+\s*|\s*[,\-·:]+$/g, '').trim();
  return out;
}
