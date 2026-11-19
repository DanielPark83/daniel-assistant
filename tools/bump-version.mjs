#!/usr/bin/env node
// 배포 전에 실행: 앱 버전을 올린다.
//   node tools/bump-version.mjs             → 오늘 날짜 기준 다음 버전 (예: 2026.11.19.2)
//   node tools/bump-version.mjs 2026.12.1.1 → 지정한 버전
//
// index.html의 모든 스크립트 주소(?v=…)와 version.json을 함께 바꾼다.
// 스크립트 주소가 버전마다 달라지므로, 브라우저가 이전 버전 파일을 메모리에서 재사용하지 못한다.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const htmlPath = new URL('index.html', root);
const jsonPath = new URL('version.json', root);

const current = JSON.parse(readFileSync(jsonPath, 'utf8')).version;
let next = process.argv[2];
if (!next) {
  const d = new Date();
  const day = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
  const m = /^(\d+\.\d+\.\d+)\.(\d+)$/.exec(current);
  next = `${day}.${m && m[1] === day ? Number(m[2]) + 1 : 1}`;
}
if (!/^[\w.-]+$/.test(next)) throw new Error(`버전 형식이 올바르지 않습니다: ${next}`);

writeFileSync(htmlPath, readFileSync(htmlPath, 'utf8').replace(/\?v=[\w.-]+/g, `?v=${next}`));
writeFileSync(jsonPath, `{ "version": "${next}" }\n`);
console.log(`${current} → ${next}`);
