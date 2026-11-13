import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickInput } from '../js/nlp.js';

// 기준 시각: 2026-11-13(금) 10:00
const NOW = new Date(2026, 10, 13, 10, 0);
const p = (text) => parseQuickInput(text, NOW);

test('날짜·시간·중요도·태그를 한 번에 해석한다', () => {
  assert.deepEqual(p('내일 오후 3시 분기 보고서 제출 !중요 #업무'), {
    title: '분기 보고서 제출', due: '2026-11-14', time: '15:00', priority: 'high', tags: ['업무'], repeat: null,
  });
});

test('상대 날짜', () => {
  assert.equal(p('오늘 장보기').due, '2026-11-13');
  assert.equal(p('모레까지 견적서 회신').due, '2026-11-15');
  assert.equal(p('모레까지 견적서 회신').title, '견적서 회신');
  assert.equal(p('3일 후 택배 확인').due, '2026-11-16');
  assert.equal(p('2주 뒤 치과 예약').due, '2026-11-27');
  assert.equal(p('월말까지 정산').due, '2026-11-30');
});

test('요일', () => {
  assert.equal(p('금요일 주간 회의').due, '2026-11-13'); // 오늘이 금요일
  assert.equal(p('월요일 기획안 검토').due, '2026-11-16');
  assert.equal(p('다음 주 수요일 워크숍').due, '2026-11-18');
  assert.equal(p('이번주 토요일 등산').due, '2026-11-14');
  assert.equal(p('다음 주 수요일 워크숍').title, '워크숍');
});

test('절대 날짜', () => {
  assert.equal(p('11월 20일 계약 갱신').due, '2026-11-20');
  assert.equal(p('12/25 선물 준비').due, '2026-12-25');
  assert.equal(p('2027-01-05 건강검진').due, '2027-01-05');
  assert.equal(p('3월 2일 개강 준비').due, '2027-03-02'); // 이미 지난 달은 내년
  assert.equal(p('25일까지 카드값 납부').due, '2026-11-25');
  assert.equal(p('5일 월세 이체').due, '2026-12-05'); // 이번 달 5일은 지났으므로 다음 달
});

test('시간', () => {
  assert.equal(p('오전 9시 반 스탠드업').time, '09:30');
  assert.equal(p('저녁 7시 가족 식사').time, '19:00');
  assert.equal(p('14:30 고객 미팅').time, '14:30');
  assert.equal(p('3시 회의').time, '15:00'); // 수식어 없는 1~6시는 오후
  assert.equal(p('11시 20분 통화').time, '11:20');
  assert.equal(p('정오 점심 약속').time, '12:00');
});

test('시간만 있으면 오늘, 이미 지났으면 내일', () => {
  assert.equal(p('오후 2시 회의').due, '2026-11-13');
  assert.equal(p('오전 9시 회의').due, '2026-11-14');
});

test('중요도', () => {
  assert.equal(p('서버 점검 !!').priority, 'high');
  assert.equal(p('긴급 서버 점검').priority, 'high');
  assert.equal(p('긴급 서버 점검').title, '서버 점검');
  assert.equal(p('책 반납 !낮음').priority, 'low');
  assert.equal(p('책 반납 p3').priority, 'low');
  assert.equal(p('우유 사기').priority, 'medium');
  assert.equal(p('중요한 회의 준비').title, '중요한 회의 준비'); // 단어 일부는 건드리지 않는다
});

test('반복', () => {
  const r = p('매주 월요일 주간 보고 #업무');
  assert.equal(r.repeat, 'weekly');
  assert.equal(r.due, '2026-11-16');
  assert.equal(r.title, '주간 보고');
  assert.equal(p('매일 운동').due, '2026-11-13');
});

test('해석할 것이 없으면 원문이 제목', () => {
  assert.deepEqual(p('  우유 사기  '), {
    title: '우유 사기', due: null, time: null, priority: 'medium', tags: [], repeat: null,
  });
  assert.equal(p('2일간 출장 준비').due, null);
  assert.equal(p('오늘의 할 일 정리').title, '오늘의 할 일 정리');
});

test('잘못된 날짜는 무시한다', () => {
  assert.equal(p('13월 40일 테스트').due, null);
  assert.equal(p('2/30 테스트').due, null);
});
