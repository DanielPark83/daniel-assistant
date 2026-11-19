// Daniel's 개인 비서 — 알림 발송기 (Cloudflare Worker)
//
// 1분마다 실행되어, 비공개 데이터 저장소의 동기화 파일(data/assistant.json)을 읽고
//  - 그 1분 안에 울려야 하는 할 일·일정 알람
//  - 정해진 시각(기본 08:00)의 아침 브리핑
// 을 알림을 켠 모든 기기로 보낸다. 앱이 꺼져 있어도 받을 수 있다.
//
// 설정(Cloudflare 변수)
//   GITHUB_TOKEN        (비밀) 데이터 저장소 읽기 권한(Contents: Read-only) 토큰
//   DATA_REPO           데이터 저장소, 예: DanielPark83/Obsidian-mobile
//   DATA_BRANCH         데이터가 있는 브랜치
//   TZ_OFFSET_MINUTES   시간대(분). 한국 540
//   BRIEFING_TIME       아침 브리핑 시각 "HH:MM", 끄려면 "off"
//   VAPID_SUBJECT       알림 서버에 알릴 연락처(https:// 주소)
//
// 시간 계산: Workers의 시계는 UTC이므로, 현재 시각에 시간대만큼 더한 "벽시계 시각"으로
// 앱과 같은 함수(dueReminders, buildMorningPush)를 그대로 쓴다.

import { normalize } from '../js/store.js';
import { dueReminders } from '../js/reminders.js';
import { buildMorningPush } from '../js/briefing.js';
import { sendWebPush } from './webpush.js';

const DATA_PATH = 'data/assistant.json';

export function targets(state) {
  if (!state.vapid) return [];
  return Object.entries(state.devices)
    .filter(([, d]) => d.push && d.vapidKey === state.vapid.publicKey)
    .map(([id, d]) => ({ id, label: d.label, subscription: d.push }));
}

const hhmm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;

// scheduledTime(실제 시각, ms)에 보낼 알림들. 벽시계로 (T-1분, T] 사이에 울릴 알람 + 브리핑 시각이면 브리핑
export function messagesFor(state, scheduledTime, { offsetMinutes = 540, briefingTime = '08:00' } = {}) {
  const offset = offsetMinutes * 60000;
  const wall = Math.floor((scheduledTime + offset) / 60000) * 60000; // 분 단위로 맞춘다
  const now = new Date(wall);
  const out = dueReminders(state, new Date(wall - 60000), now).map((r) => ({
    kind: 'reminder', title: r.title, body: r.body, url: r.url, tag: r.key,
  }));
  if (briefingTime && briefingTime !== 'off' && hhmm(now) === briefingTime) {
    const b = buildMorningPush(state, now, { clockOffsetMs: offset });
    out.push({ kind: 'briefing', title: b.title, body: b.body, url: b.url, tag: b.tag });
  }
  return out;
}

async function loadState(env, fetchImpl) {
  const url = `https://api.github.com/repos/${env.DATA_REPO}/contents/${DATA_PATH}?ref=${encodeURIComponent(env.DATA_BRANCH || 'main')}`;
  const res = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github.raw+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'daniel-assistant-notifier',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 404) return null; // 아직 동기화 전
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return normalize(await res.json());
}

export async function run(env, scheduledTime, fetchImpl = fetch) {
  if (!env.GITHUB_TOKEN || !env.DATA_REPO) return { skipped: 'not-configured' };
  const state = await loadState(env, fetchImpl);
  if (!state) return { skipped: 'no-data' };
  const list = targets(state);
  if (!list.length) return { skipped: 'no-devices' };
  const messages = messagesFor(state, scheduledTime, {
    offsetMinutes: Number(env.TZ_OFFSET_MINUTES ?? 540),
    briefingTime: env.BRIEFING_TIME ?? '08:00',
  });
  if (!messages.length) return { sent: 0 };

  const vapid = { subject: env.VAPID_SUBJECT || 'https://github.com/', publicKey: state.vapid.publicKey, privateKey: state.vapid.privateKey };
  const results = [];
  for (const m of messages) {
    const payload = JSON.stringify({ title: m.title, body: m.body, url: m.url, tag: m.tag });
    for (const t of list) {
      try {
        const r = await sendWebPush(t.subscription, payload, vapid, {
          ttl: m.kind === 'briefing' ? 6 * 3600 : 1800, urgency: 'high', fetchImpl,
        });
        results.push({ kind: m.kind, device: t.label, ...r });
      } catch (err) {
        results.push({ kind: m.kind, device: t.label, ok: false, error: String(err && err.message || err) });
      }
    }
  }
  // 로그에는 내용(제목)을 남기지 않는다
  console.log(JSON.stringify({ at: new Date(scheduledTime).toISOString(), results: results.map(({ kind, device, ok, status, expired, error }) => ({ kind, device, ok, status, expired, error })) }));
  return { sent: results.filter((r) => r.ok).length, results };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, event.scheduledTime).catch((err) => console.log(`실패: ${err.message}`)));
  },
  // 주소로 열면 동작 여부만 알려 준다(내용은 보여 주지 않는다)
  async fetch() {
    return new Response("Daniel's 개인 비서 알림 발송기 — 동작 중\n", { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};
