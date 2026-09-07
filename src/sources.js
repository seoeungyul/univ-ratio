'use strict';
/**
 * 대학 목록(어느 대학의 경쟁률 페이지가 어디인지) 수집.
 *
 *  - 진학어플라이 SmartRatio : 페이지의 hidden input(hdnResultNow/Past)에
 *                              전 대학 목록이 JSON으로 통째로 박혀 있다.
 *  - 유웨이 파워경쟁률       : <tr data-state="…"> 테이블을 서버사이드 렌더링한다.
 *
 * 두 목록을 합쳐 "대학명 → 경쟁률 URL" 색인을 만든다.
 * 참고: 유웨이 목록에도 진학사가 접수하는 대학이 섞여 있고(반대도 마찬가지),
 *       RatioLink 도메인으로 실제 제공사를 판별한다.
 */

const { fetchText } = require('./fetch');
const { textOf } = require('./parser');

const JINHAK_INDEX = 'https://apply.jinhakapply.com/SmartRatio';
const UWAY_INDEX = 'https://info.uway.com/power/?isApply=1';

const decodeEntities = (s) =>
  String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

function providerOf(url) {
  if (/uwayapply\.com/i.test(url)) return 'uway';
  if (/jinhakapply\.com/i.test(url)) return 'jinhak';
  return 'etc'; // 대학 자체 홈페이지에서 경쟁률을 제공하는 경우
}

/**
 * 유웨이 목록은 실제 경쟁률 주소를 래퍼 URL에 감싸 놓기도 한다.
 *   ratio.uwayapply.com/power/?ratioURL=%2F%2Fratio.uwayapply.com%2FXXXX&…
 * 안쪽 주소를 꺼내 진학 목록과 같은 형태로 맞춘다.
 */
function unwrapRatioUrl(url) {
  const m = /[?&]ratioURL=([^&]+)/i.exec(url || '');
  if (!m) return url;
  let inner = decodeURIComponent(m[1]);
  if (inner.startsWith('//')) inner = 'https:' + inner;
  return inner;
}

/* ---------------- 진학어플라이 ---------------- */
async function fetchJinhakIndex() {
  const html = await fetchText(JINHAK_INDEX);
  const out = [];

  for (const id of ['hdnResultNow', 'hdnResultPast']) {
    const m = new RegExp(`id="${id}"[^>]*value="([\\s\\S]*?)"\\s*/?>`, 'i').exec(html);
    if (!m) continue;
    let data;
    try {
      data = JSON.parse(decodeEntities(m[1]));
    } catch {
      continue;
    }
    const cols = data.Columns || [];
    for (const row of data.Rows || []) {
      const o = {};
      cols.forEach((c, i) => (o[c] = row[i]));
      const link = String(o.RatioLink || '').trim();
      if (!link || link.length < 10) continue; // '　'(전각공백)으로 채워진 미제공 행
      out.push({
        univ: String(o.UnivName || '').trim(),
        univType: o.UnivType, // 4=4년제, 2=전문대 …
        category: o.CategoryDisplayName || o.CategoryName || '',
        region: o.PresidentName || '',
        establishment: o.SpecialCode || '',
        year: o.SchoolYear,
        applyFrom: o.ApplyFromTime || '',
        applyTo: o.ApplyToTime || '',
        applyLink: o.WonseoLink || '',
        homepage: o.HomePage || '',
        ratioUrl: link,
        provider: providerOf(link),
        index: 'jinhak',
        current: id === 'hdnResultNow',
      });
    }
  }
  return out;
}

/* ---------------- 유웨이 ---------------- */
async function fetchUwayIndex() {
  const html = await fetchText(UWAY_INDEX);
  const out = [];

  const trRe = /<tr\s+data-state=["']([^"']*)["'][^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const state = m[1];
    const body = m[2];

    const abbrs = [];
    const tdRe = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
    let t;
    const tds = [];
    while ((t = tdRe.exec(body)) !== null) {
      const a = /abbr=["']([^"']*)["']/i.exec(t[1]);
      abbrs.push(a ? decodeEntities(a[1]).trim() : textOf(t[2]));
      tds.push(t[2]);
    }
    // 컬럼: 상태 / 구분 / 지역 / 설립 / 대학명 / 접수기간 / 경쟁률버튼
    const last = tds[tds.length - 1] || '';
    const rawLink = (/href=["']([^"']+)["']/i.exec(last) || ['', ''])[1];
    if (!rawLink) continue;
    const link = unwrapRatioUrl(decodeEntities(rawLink));
    if (!/^https?:\/\//i.test(link)) continue; // 'javascript:void(0)' 등 실제 주소가 없는 행

    const period = abbrs[5] || '';
    const [from, to] = period.split('~').map((s) => s.trim());
    out.push({
      univ: (abbrs[4] || '').trim(),
      univType: /전문대|전문/.test(abbrs[1] || '') ? 2 : 4,
      category: abbrs[1] || '',
      region: abbrs[2] || '',
      establishment: abbrs[3] || '',
      year: undefined,
      applyFrom: from || '',
      applyTo: to || '',
      applyLink: (/href=["']([^"']+)["']/i.exec(tds[4] || '') || ['', ''])[1],
      homepage: '',
      ratioUrl: link.replace(/^http:/, 'https:'),
      provider: providerOf(link),
      index: 'uway',
      current: /접수중|접수 중/.test(state),
      state,
    });
  }
  return out;
}

/** 두 목록을 합치고 (대학명 + 전형구분) 기준으로 중복 제거 */
async function fetchIndex() {
  const settled = await Promise.allSettled([fetchJinhakIndex(), fetchUwayIndex()]);
  const all = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (!all.length) {
    const err = settled.find((r) => r.status === 'rejected');
    throw new Error(`대학 목록을 가져오지 못했습니다: ${err ? err.reason : 'empty'}`);
  }

  const seen = new Map();
  for (const it of all) {
    if (!it.univ) continue;
    const key = `${it.univ}|${it.ratioUrl}`;
    // 진학 색인이 메타데이터(학년도·마감시각)가 더 풍부하므로 우선한다.
    if (!seen.has(key) || it.index === 'jinhak') seen.set(key, it);
  }
  return [...seen.values()].sort((a, b) => a.univ.localeCompare(b.univ, 'ko'));
}

/** 검색어로 대학 찾기 (공백/괄호 무시, 부분 일치) */
const norm = (s) => String(s || '').replace(/[\s()（）·・.]/g, '').toLowerCase();

function searchIndex(list, query, opts = {}) {
  const q = norm(query);
  if (!q) return [];
  let hits = list.filter((it) => norm(it.univ).includes(q));
  if (opts.category) hits = hits.filter((it) => (it.category || '').includes(opts.category));
  if (opts.provider) hits = hits.filter((it) => it.provider === opts.provider);
  if (opts.currentOnly) hits = hits.filter((it) => it.current);
  // 완전 일치를 앞으로
  return hits.sort((a, b) => (norm(b.univ) === q) - (norm(a.univ) === q));
}

module.exports = { fetchIndex, fetchJinhakIndex, fetchUwayIndex, searchIndex, JINHAK_INDEX, UWAY_INDEX };
