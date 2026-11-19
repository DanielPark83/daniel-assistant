# 알림 발송기 (Cloudflare Worker)

앱이 꺼져 있어도 할 일·일정 알람과 오전 8시 브리핑을 보내는 작은 서버입니다. 1분마다 실행되어 데이터 저장소(`Obsidian-mobile`)의 `data/assistant.json`을 읽고, 그 1분 안에 울릴 알람을 알림을 켠 기기로 보냅니다. Cloudflare 무료 요금제로 충분합니다.

## 설치 (Cloudflare 대시보드에서, 한 번만)

1. **GitHub 읽기 전용 토큰 만들기** — https://github.com/settings/personal-access-tokens/new
   - Repository access: **Only select repositories → Obsidian-mobile**
   - Permissions: **Contents → Read-only**
2. **Cloudflare 가입** — https://dash.cloudflare.com/sign-up
3. **Worker 만들기** — Workers & Pages → Create → Hello World 템플릿, 이름 `daniel-assistant-notifier` → Deploy
4. **코드 넣기** — Edit code → 기존 코드를 모두 지우고 [dist/worker.js](https://raw.githubusercontent.com/DanielPark83/daniel-assistant/main/cloudflare/dist/worker.js) 내용을 붙여 넣기 → Deploy
5. **토큰 넣기** — Settings → Variables and Secrets → Add → Type **Secret**, Name `GITHUB_TOKEN`, Value에 1번 토큰 → Deploy
6. **1분마다 실행** — Settings → Trigger Events → Add → Cron Triggers → `* * * * *`(매 분) → Add
7. **확인** — Worker 주소(`https://daniel-assistant-notifier.<계정>.workers.dev`)를 열면 상태가 나옵니다. "정상 — 데이터를 읽었습니다"면 끝입니다.

나머지 설정(데이터 저장소, 브랜치, 시간대 한국, 브리핑 8시)은 코드의 `DEFAULTS`에 들어 있습니다. 바꾸려면 같은 이름의 변수(Text)를 추가하면 됩니다: `DATA_REPO`, `DATA_BRANCH`, `TZ_OFFSET_MINUTES`, `BRIEFING_TIME`(끄려면 `off`), `VAPID_SUBJECT`.

## 코드 업데이트

`cloudflare/`나 앱의 알람·브리핑 코드(`js/reminders.js`, `js/briefing.js`, `js/store.js`)가 바뀌면 `npm run build:worker`로 `dist/worker.js`를 다시 만들고, 4번처럼 붙여 넣어 Deploy 합니다.

## 개인정보

- Worker는 데이터를 읽기만 하고 저장하지 않습니다. 로그에는 기기 이름과 성공 여부만 남기고 할 일·일정 내용은 남기지 않습니다.
- 알림 내용은 기기별로 암호화되어(Web Push, RFC 8291) 전달됩니다.
