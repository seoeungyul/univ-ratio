'use strict';
/**
 * gas/경쟁률.gs 를 Apps Script 서비스 스텁 위에서 그대로 실행해 보는 검증 스크립트.
 * (UrlFetchApp / CacheService / Utilities 만 흉내 내면 파싱 로직 전체가 그대로 돈다)
 *
 *   node test/gas-smoke.js [대학명 ...]
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** UrlFetchApp 은 동기 API 라서, 미리 받아 둔 응답을 돌려주도록 만든다. */
const responses = new Map();

async function prefetch(url) {
  if (responses.has(url)) return;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  responses.set(url, { code: res.status, buf, ctype: res.headers.get('content-type') || '' });
}

const sandbox = {
  console,
  UrlFetchApp: {
    fetch(url) {
      const r = responses.get(url);
      if (!r) throw new Error('테스트 스텁에 미리 받아두지 않은 주소: ' + url);
      return {
        getResponseCode: () => r.code,
        getHeaders: () => ({ 'Content-Type': r.ctype }),
        getContentText(enc) {
          const cs = /euc-?kr/i.test(enc || '') ? 'euc-kr' : enc || 'utf-8';
          return new TextDecoder(cs).decode(r.buf);
        },
      };
    },
  },
  CacheService: {
    getScriptCache: () => {
      const m = new Map();
      return { get: (k) => m.get(k) || null, put: (k, v) => m.set(k, v) };
    },
  },
  Utilities: { base64EncodeWebSafe: (s) => Buffer.from(s).toString('base64url') },
};
vm.createContext(sandbox);

const code = fs.readFileSync(path.join(__dirname, '..', 'gas', '경쟁률.gs'), 'utf8');
vm.runInContext(code, sandbox, { filename: '경쟁률.gs' });

(async () => {
  const names = process.argv.slice(2);
  const targets = names.length ? names : ['한양대학교(서울)', '중앙대학교', '가천대학교', '가톨릭관동대학교'];

  await prefetch(sandbox.JINHAK_INDEX);
  await prefetch(sandbox.UWAY_INDEX);
  const index = sandbox.fetchUnivIndex();
  console.log('대학 색인:', index.length, '건');

  let fail = 0;
  for (const name of targets) {
    const hit = index.find((it) => it.univ.replace(/\s/g, '').includes(name.replace(/\s/g, ''))) ||
      index.find((it) => it.univ.includes(name.slice(0, 3)));
    if (!hit) {
      console.log('✗', name, '— 색인에 없음');
      fail++;
      continue;
    }
    await prefetch(hit.ratioUrl);
    const r = sandbox.fetchRatioByName(name);
    const units = r.groups.reduce((a, g) => a + g.units.length, 0);
    const rows = sandbox.flattenRatio(r, r.matched.univ);
    console.log(
      `✓ ${r.univ} | ${r.year} ${r.category} | 전형 ${r.groups.length} · 모집단위 ${units} · 시트행 ${rows.length}` +
        ` | 총계 ${r.summary ? `${r.summary.quota}명 모집 / ${r.summary.applied}명 지원 / ${r.summary.ratio}:1` : '-'}` +
        ` | ${r.updatedAt}`
    );
    if (!rows.length) fail++;
    const sample = rows[0];
    if (sample) console.log('   예) ' + [sample.전형, sample.모집단위, sample.모집인원, sample.지원인원, sample.경쟁률].join(' / '));
  }

  // 시트 함수도 확인
  const kaya = index.find((it) => it.univ.startsWith('가야대학교'));
  if (kaya) await prefetch(kaya.ratioUrl);
  const t = sandbox.RATIO_TABLE('가야대학교');
  console.log('RATIO_TABLE 행 수:', t.length, '| 머리글:', t[0].join(','));
  const one = sandbox.RATIO('가야대학교');
  console.log('RATIO 전체:', JSON.stringify(one));

  process.exit(fail ? 1 : 0);
})();
