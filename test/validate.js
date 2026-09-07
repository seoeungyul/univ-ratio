'use strict';
/**
 * 색인에 있는 모든 대학의 경쟁률 페이지를 실제로 받아 파싱해 보는 점검 스크립트.
 *
 *   node test/validate.js            # 접수 중인 대학 전체
 *   node test/validate.js 20         # 앞에서 20곳만
 *
 * 확인 항목
 *   - 페이지를 받아 파싱했는가 (전형이 하나라도 나왔는가)
 *   - 전형별 총계가 모집단위 지원인원 합과 맞는가
 *     (통합모집처럼 사이트가 값을 병합해 둔 표는 어긋날 수 있어 경고로만 남긴다)
 */

const { fetchIndex } = require('../src/sources');
const { fetchText } = require('../src/fetch');
const { parseRatio } = require('../src/parser');

const CONCURRENCY = 8;

(async () => {
  const limit = Number(process.argv[2]) || 0;
  let list = (await fetchIndex()).filter((it) => it.provider !== 'etc' && it.current);
  if (limit) list = list.slice(0, limit);

  const stats = { total: list.length, parsed: 0, empty: 0, failed: 0, units: 0, warned: 0 };
  const notes = [];
  const queue = [...list];

  async function worker() {
    while (queue.length) {
      const it = queue.shift();
      try {
        const html = await fetchText(it.ratioUrl, { retries: 1 });
        const r = parseRatio(html, it.ratioUrl);
        const units = r.groups.reduce((a, g) => a + g.units.length, 0);
        stats.units += units;

        if (!r.groups.length) {
          stats.empty++;
          notes.push(`· 데이터 없음  ${it.univ}  ${r.updatedAt || ''}`);
        } else {
          stats.parsed++;
        }

        for (const g of r.groups) {
          if (!g.units.length || !g.total) continue;
          let sum = 0;
          for (const u of g.units) if (!u.appliedShared) sum += u.applied;
          if (sum !== g.total.applied) {
            stats.warned++;
            notes.push(`· 합계 불일치  ${it.univ} / ${g.name}: 모집단위 합 ${sum} ≠ 표기 총계 ${g.total.applied}`);
          }
        }
      } catch (e) {
        stats.failed++;
        notes.push(`· 조회 실패    ${it.univ}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log('대상 대학          :', stats.total);
  console.log('파싱 성공          :', stats.parsed);
  console.log('데이터 없음        :', stats.empty, '(서비스 오픈 전 / 링크 안내 페이지)');
  console.log('조회 실패          :', stats.failed, '(404 등)');
  console.log('모집단위 행        :', stats.units.toLocaleString('ko-KR'));
  console.log('합계 불일치 경고   :', stats.warned);
  if (notes.length) {
    console.log('\n[상세]');
    notes.forEach((n) => console.log(n));
  }
  process.exit(stats.parsed === 0 ? 1 : 0);
})();
