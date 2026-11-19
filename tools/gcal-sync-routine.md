# 구글 캘린더 동기화 예약 작업 만들기 (Claude용 안내)

개인 비서 앱의 일정을 1시간마다 구글 캘린더로 옮기는 Claude 예약 작업(scheduled task)을 만든다.
이 작업은 **Google Calendar 커넥터가 연결된 세션에서** 만들어야 한다(예약 작업은 만드는 세션이 가진 커넥터만 넘겨받는다).

## 만드는 세션이 할 일

1. 이 세션에 Google Calendar 커넥터 도구(`mcp__...` 중 캘린더 도구)가 있는지 확인한다. 없으면 사용자에게 https://claude.ai/customize/connectors 에서 Google Calendar를 다시 연결한 뒤 **새 세션**을 열어 달라고 하고 멈춘다.
2. 예전에 커넥터 없이 만들어 꺼 둔 작업 `trig_01GVK44K54HbgaJszkGijojq`가 있으면 지운다(`delete_trigger`).
3. 예약 작업을 만든다(`create_trigger`):
   - name: `구글 캘린더 동기화 (개인 비서 → 구글)`
   - cron_expression: `0 * * * *` (1시간마다)
   - create_new_session_on_fire: `true`
   - notifications: `{}` (매시간 알림을 보내지 않는다)
   - connectors: `["Google Calendar"]` — 조직 설정상 이 값을 쓸 수 없다고 하면 빼고 만든 뒤, 결과에 "커넥터가 저장되지 않았다"는 경고가 있으면 사용자에게 그대로 알린다.
   - prompt: 아래 "실행 내용" 전체
4. `fire_trigger`로 한 번 바로 실행하고, 그 세션이 끝나면 결과(추가·수정·삭제 개수)를 사용자에게 알려 준다.

## 실행 내용 (prompt에 그대로 넣는다)

```
개인 비서 앱의 일정을 구글 캘린더로 옮기는 한 방향 동기화를 실행한다(앱 → 구글). 매시간 자동으로 실행되는 작업이므로 사용자에게 질문하지 말고 끝까지 진행한다.

0. Google Calendar 커넥터 도구가 이 세션에 없으면 아무것도 하지 말고 "Google Calendar 커넥터가 연결되어 있지 않아 동기화하지 못했습니다(claude.ai/customize/connectors에서 다시 연결 필요)"라고만 보고하고 끝낸다.

1. 저장소 준비(읽기만): DanielPark83/daniel-assistant(공개, 코드)와 DanielPark83/Obsidian-mobile(비공개, 데이터 파일 data/assistant.json). 세션에 없으면 add_repo로 추가하고 --depth 1로 clone한다. Obsidian-mobile은 기본 브랜치(claude/festive-carson-m3r30t)의 최신 내용을 쓴다.

2. Google Calendar 커넥터로 기본 캘린더(primary)에서, 설명(description)에 "da-sync:"가 들어 있는 일정을 모두 찾는다. 기간은 오늘(한국 시간)부터 60일 전 ~ 2년 뒤. 반복 일정은 회차가 아니라 원본 시리즈 하나로 센다(회차 ID가 아니라 시리즈 ID). 찾은 것을 [{"id": "구글 일정(시리즈) ID", "description": "설명 전체"}] 형식의 JSON으로 existing.json 파일에 저장한다. 하나도 없으면 [].

3. 계획 만들기: node daniel-assistant/tools/gcal-sync-plan.mjs Obsidian-mobile/data/assistant.json existing.json
   출력 JSON: create(새로 만들 일정), update(id 일정을 event 내용으로 바꾸기), delete(지울 구글 일정 id), unchanged(그대로인 개수).

4. create·update·delete가 모두 0이면 아무것도 바꾸지 말고 바로 6번으로 간다.

5. 계획을 Google Calendar 커넥터로 그대로 실행한다(기본 캘린더 primary):
   - create: event의 summary, description, location, start, end, recurrence, reminders를 그대로 넣어 새 일정을 만든다. 시간대는 Asia/Seoul. description은 한 글자도 바꾸지 않는다(마지막 줄의 da-sync 표시로 다음 실행 때 짝을 찾는다).
   - update: 해당 id 일정을 event 내용으로 바꾼다(반복 일정이면 시리즈 전체).
   - delete: 해당 id 일정을 지운다(반복 일정이면 시리즈 전체).
   - 설명에 "da-sync:"가 없는 일정은 절대 고치거나 지우지 않는다. 계획에 없는 일은 하지 않는다.
   - 커넥터가 어떤 필드(예: recurrence, reminders)를 지원하지 않으면 지원하는 필드만으로 실행하고, 무엇을 못 넣었는지 결과에 적는다.
   - 하나가 실패해도 나머지는 계속한다.

6. 마지막에 개수만 짧게 보고한다: 추가 N, 수정 N, 삭제 N, 그대로 N, 실패 N(이유). 일정 제목·내용은 보고에 쓰지 않는다. 저장소에는 아무것도 커밋하거나 푸시하지 않는다.
```

## 동작 요약

- 한 방향(앱 → 구글)이다. 구글 캘린더에서 고친 내용은 앱으로 오지 않고, 다음 실행 때 앱 내용으로 되돌아간다.
- 앱이 만든 일정에는 설명 마지막 줄에 `da-sync:<앱 일정 ID>:<수정 시각>` 표시가 붙는다. 표시가 없는 일정(구글에서 직접 만든 일정)은 건드리지 않는다.
- 구글 쪽 알림은 끈다(앱의 알림 발송기가 알람을 보내므로 두 번 울리지 않게).
- 계획 계산은 `tools/gcal-sync-plan.mjs`(테스트: `tests/gcal-plan.test.js`)가 한다.
