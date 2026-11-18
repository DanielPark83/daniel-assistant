#!/usr/bin/env node
// 아침 브리핑 알림 보내기.
// 데이터 저장소의 GitHub Actions가 매일 아침 이 스크립트를 실행한다.
//
//   node tools/send-briefing.mjs <동기화 데이터 파일(data/assistant.json)>
//
// 환경 변수
//   TZ             브리핑 기준 시간대 (예: Asia/Seoul)
//   WAIT_UNTIL     "08:00"처럼 주면, 그보다 조금 일찍 시작했을 때 그 시각까지 기다린다(최대 20분)
//   VAPID_SUBJECT  알림 서버에 알릴 연락처(https:// 또는 mailto:)
//
// 'web-push' 패키지가 필요하다(npm install web-push).

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { normalize } from '../js/store.js';
import { buildMorningPush } from '../js/briefing.js';

// 알림을 보낼 기기: 구독이 있고, 현재 알림 키로 구독한 기기
export function targets(state) {
  if (!state.vapid) return [];
  return Object.entries(state.devices)
    .filter(([, d]) => d.push && d.vapidKey === state.vapid.publicKey)
    .map(([id, d]) => ({ id, label: d.label, subscription: d.push }));
}

// send(subscription, payload, options) 는 web-push의 sendNotification과 같은 모양
export async function sendAll(state, { now = new Date(), send, subject }) {
  const list = targets(state);
  const message = buildMorningPush(state, now);
  const payload = JSON.stringify(message);
  const results = [];
  for (const t of list) {
    try {
      const res = await send(t.subscription, payload, {
        vapidDetails: { subject, publicKey: state.vapid.publicKey, privateKey: state.vapid.privateKey },
        TTL: 6 * 3600,
        urgency: 'normal',
        topic: 'briefing',
      });
      results.push({ ...t, ok: true, status: res && res.statusCode });
    } catch (err) {
      const status = err && err.statusCode;
      results.push({ ...t, ok: false, status, expired: status === 404 || status === 410, error: (err && err.body) || String(err) });
    }
  }
  return { message, results };
}

export function msUntil(hhmm, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return 0;
  const target = new Date(now);
  target.setHours(Number(m[1]), Number(m[2]), 0, 0);
  const diff = target - now;
  return diff > 0 && diff <= 20 * 60000 ? diff : 0;
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('사용법: node tools/send-briefing.mjs <data/assistant.json>');
    process.exit(2);
  }
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('아직 동기화 데이터가 없습니다. 앱에서 기기 간 동기화를 연결하면 다음 날부터 보냅니다.');
      return;
    }
    throw err;
  }
  const state = normalize(JSON.parse(raw));
  const list = targets(state);
  if (!list.length) {
    console.log('알림을 켠 기기가 없습니다. 앱의 설정 → 아침 브리핑 알림에서 켜 주세요.');
    return;
  }

  const wait = msUntil(process.env.WAIT_UNTIL);
  if (wait) {
    console.log(`${process.env.WAIT_UNTIL}까지 ${Math.round(wait / 1000)}초 기다립니다.`);
    await new Promise((r) => setTimeout(r, wait));
  }

  const { default: webpush } = await import('web-push');
  const subject = process.env.VAPID_SUBJECT || 'https://github.com/';
  const { message, results } = await sendAll(state, {
    send: (sub, payload, opts) => webpush.sendNotification(sub, payload, opts),
    subject,
  });

  console.log(`${message.title}: ${list.length}개 기기에 보냄`);
  results.forEach((r) => {
    if (r.ok) console.log(`  ✓ ${r.label} (${r.status})`);
    else if (r.expired) console.log(`  ✗ ${r.label}: 알림 구독이 만료되었습니다. 그 기기의 앱에서 설정 → 아침 브리핑 알림을 껐다가 다시 켜 주세요.`);
    else console.log(`  ✗ ${r.label}: 보내지 못했습니다 (${r.status || '오류'}) ${String(r.error).slice(0, 200)}`);
  });
  if (results.every((r) => !r.ok)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
