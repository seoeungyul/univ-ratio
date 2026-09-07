'use strict';
/**
 * 진학어플라이(addon.jinhakapply.com) / 유웨이(ratio.uwayapply.com) 경쟁률 HTML 파서.
 *
 * 두 사이트 모두 "… , 모집인원, 지원인원, 경쟁률(x.xx : 1)" 형태의 표를 쓰지만
 * 대학마다 컬럼 구성이 제각각이고(캠퍼스/계열/전형안내/학과홈페이지 …)
 * 통합모집처럼 rowspan 으로 칸이 병합된 표도 많다. 그래서
 *   1) 표를 rowspan/colspan 까지 펼친 그리드로 만든 뒤,
 *   2) 경쟁률 셀("x.xx : 1")을 찾아 그 앞 두 칸을 인원으로 읽고,
 *   3) <th> 헤더에서 '모집단위' 컬럼 위치를 찾아 이름을 잡는다.
 */

const RATIO_CELL = /^-?\s*(\d+(?:\.\d+)?)\s*:\s*1$/;
const RATIO_ANY = /\d+(?:\.\d+)?\s*:\s*1/;
const UNIT_HEADER = /모집\s*단위|학과|전공|모집단위명/;
const RATIO_HEADER = /^경쟁\s*률$/;
const QUOTA_HEADER = /모집\s*인원|총\s*모집/;
const APPLIED_HEADER = /지원\s*인원|접수\s*인원/;

/** 태그·엔티티 제거 후 공백 정리 */
function textOf(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripScripts(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

const spanOf = (attrs, name) => {
  const m = new RegExp(`${name}\\s*=\\s*["']?\\s*(\\d+)`, 'i').exec(attrs || '');
  const n = m ? parseInt(m[1], 10) : 1;
  return n > 0 && n < 200 ? n : 1;
};

/**
 * 표(또는 tr 묶음) 하나를 rowspan/colspan 을 펼친 2차원 배열로 만든다.
 * 병합으로 이어받은 칸은 값을 그대로 복사하되 spanned=true 로 표시한다.
 * (복사된 모집인원을 합계에 중복으로 더하지 않기 위해 필요하다)
 */
function tableGrid(html) {
  const grid = [];
  const carry = new Map(); // 열 → { text, left, width }

  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const cells = [];
    let ths = 0;
    const tdRe = /<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) {
      if (c[1].toLowerCase() === 'h') ths++;
      cells.push({ text: textOf(c[3]), colspan: spanOf(c[2], 'colspan'), rowspan: spanOf(c[2], 'rowspan') });
    }
    if (!cells.length) continue;

    const row = [];
    const used = new Set();
    let col = 0;
    let ci = 0;
    // 셀이 남아 있거나, 아직 채워야 할 병합 칸이 있는 동안 계속 채운다.
    for (let guard = 0; guard < 400; guard++) {
      const held = carry.get(col);
      if (held && held.left > 0) {
        row[col] = { text: held.text, spanned: true };
        for (let k = 1; k < held.width; k++) row[col + k] = { text: '', spanned: true };
        used.add(col);
        col += held.width;
        continue;
      }
      if (ci >= cells.length) break;
      const cell = cells[ci++];
      row[col] = { text: cell.text, spanned: false };
      for (let k = 1; k < cell.colspan; k++) row[col + k] = { text: '', spanned: false };
      if (cell.rowspan > 1) carry.set(col, { text: cell.text, left: cell.rowspan - 1, width: cell.colspan });
      col += cell.colspan;
    }
    for (const k of used) {
      const held = carry.get(k);
      if (held && --held.left <= 0) carry.delete(k);
    }

    const filled = Array.from(row, (v) => v || { text: '', spanned: false });
    grid.push({ cells: filled.map((v) => v.text), spans: filled.map((v) => v.spanned), allHeader: ths === cells.length });
  }
  return grid;
}

/**
 * 헤더 행에서 '모집단위' 컬럼 위치와 폭을 찾는다.
 * 헤더가 colspan 으로 두 칸을 덮으면(학부+전공) 그 범위를 모두 이름으로 쓴다.
 */
function headerLayout(grid) {
  const head = grid.find(
    (r) => r.allHeader && r.cells.some((c) => UNIT_HEADER.test(c) || RATIO_HEADER.test(c))
  );
  if (!head) return null;
  const unitIdx = head.cells.findIndex((c) => UNIT_HEADER.test(c));
  let unitWidth = 1;
  while (unitIdx >= 0 && unitIdx + unitWidth < head.cells.length && head.cells[unitIdx + unitWidth] === '') {
    unitWidth++;
  }
  return {
    size: head.cells.length,
    unitIdx,
    unitWidth,
    ratioIdx: head.cells.findIndex((c) => RATIO_HEADER.test(c)),
    quotaIdx: head.cells.findIndex((c) => QUOTA_HEADER.test(c)),
    appliedIdx: head.cells.findIndex((c) => APPLIED_HEADER.test(c)),
    headers: head.cells,
  };
}

const asCount = (s) => {
  const v = String(s).replace(/[,\s]/g, '');
  return /^\d+$/.test(v) ? Number(v) : null;
};
const asRatio = (s) => {
  const m = /^-?\s*(\d+(?:\.\d+)?)\s*(?::\s*1)?$/.exec(String(s).trim());
  return m ? Number(m[1]) : null;
};

/**
 * 한 행에서 (이름들, 모집인원, 지원인원, 경쟁률) 추출. 해당 없으면 null.
 * 헤더에서 컬럼 위치를 알아냈으면 그 위치를 쓰고(경쟁률을 "0.30"처럼 ':1' 없이 쓰는 대학 대응),
 * 아니면 "x.xx : 1" 셀을 찾아 그 앞 두 칸을 인원으로 읽는다.
 */
function pickRow(cells, spans, layout) {
  let i = -1;
  let quota = null;
  let applied = null;
  let ratio = null;

  if (layout && cells.length === layout.size && layout.ratioIdx >= 0 && layout.quotaIdx >= 0 && layout.appliedIdx >= 0) {
    quota = asCount(cells[layout.quotaIdx]);
    applied = asCount(cells[layout.appliedIdx]);
    ratio = asRatio(cells[layout.ratioIdx]);
    i = layout.ratioIdx;
  }
  if (quota === null || applied === null || ratio === null) {
    i = cells.findIndex((c) => RATIO_CELL.test(c));
    if (i < 2) return null;
    quota = asCount(cells[i - 2]);
    applied = asCount(cells[i - 1]);
    ratio = asRatio(cells[i]);
    if (quota === null || applied === null || ratio === null) return null;
    return finish(i, i - 2, i - 1);
  }
  return finish(i, layout.quotaIdx, layout.appliedIdx);

  function finish(rIdx, qIdx, aIdx) {
    const nameEnd = Math.min(qIdx, aIdx, rIdx);
    return {
      ratioIdx: rIdx,
      names: cells.slice(0, nameEnd).map((s) => s.trim()).filter((s) => s && s !== '-'),
      quota,
      applied,
      ratio,
      // 위 행에서 병합되어 내려온 값이면 합계에 중복으로 더하면 안 된다(통합모집).
      quotaShared: Boolean(spans && spans[qIdx]),
      appliedShared: Boolean(spans && spans[aIdx]),
    };
  }
}

// '총계 / 합계 / 소계 / 캠퍼스별 소계' 행 판별.
// '회계학과'처럼 학과명에 '계'가 들어간 경우와 구분하기 위해 어미로만 판단한다.
const TOTAL_TEXT = /(^|\s|\)|］|])(총계|합계|소계|전체계)$|^계$|^전\s*체$/;
const isTotalRow = (row, cells) =>
  cells.some((c) => TOTAL_TEXT.test(c.trim())) || row.names.some((n) => TOTAL_TEXT.test(n));

/** 모집단위 이름/소속 결정 */
function unitOf(row, cells, layout) {
  let unit = '';
  let college = '';

  if (layout && cells.length === layout.size && layout.unitIdx >= 0) {
    unit = cells
      .slice(layout.unitIdx, layout.unitIdx + (layout.unitWidth || 1))
      .map((s) => s.trim())
      .filter((s) => s && s !== '-')
      .join(' ');
    college = cells
      .slice(0, layout.unitIdx)
      .map((s) => s.trim())
      .filter((s) => s && s !== '-')
      .join(' > ');
  }
  if (!unit) {
    const n = row.names;
    unit = n.length ? n[n.length - 1] : '';
    college = n.length > 1 ? n.slice(0, -1).join(' > ') : '';
  }
  return {
    unit,
    college,
    quota: row.quota,
    applied: row.applied,
    ratio: row.ratio,
    quotaShared: row.quotaShared,
    appliedShared: row.appliedShared,
  };
}

/** 모집인원/지원인원이 병합된 통합모집 행은 한 번만 세도록 합산 */
function totalizeUnits(units) {
  if (!units || !units.length) return null;
  let quota = 0;
  let applied = 0;
  for (const u of units) {
    if (!u.quotaShared) quota += u.quota;
    if (!u.appliedShared) applied += u.applied;
  }
  return { quota, applied, ratio: quota ? Number((applied / quota).toFixed(2)) : 0 };
}

function totalize(list) {
  const rows = (list || []).filter(Boolean);
  if (!rows.length) return null;
  const quota = rows.reduce((a, b) => a + b.quota, 0);
  const applied = rows.reduce((a, b) => a + b.applied, 0);
  return { quota, applied, ratio: quota ? Number((applied / quota).toFixed(2)) : 0 };
}

/**
 * 전형 블록(<div id="SelType…"> 또는 <div id="Div_…"> 하나) 에서 모집단위 목록 + 총계 뽑기.
 * 블록 안에 제목용 표가 먼저 오는 대학이 있어 "경쟁률 값이 들어있는 표"만 골라 쓴다.
 */
function parseUnitTable(block) {
  const tables = block.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || [block];
  // 블록 앞머리에 제목/버튼용 표가 오는 대학이 있으므로 '경쟁률 값이 있는 첫 표'만 쓴다.
  const table = tables.find((t) => RATIO_ANY.test(t));
  if (!table) return { units: [], total: null };

  const grid = tableGrid(table);
  const layout = headerLayout(grid);
  const units = [];
  let total = null;
  for (const { cells, spans } of grid) {
    const r = pickRow(cells, spans, layout);
    if (!r) continue;
    if (isTotalRow(r, cells)) total = { quota: r.quota, applied: r.applied, ratio: r.ratio };
    else units.push(unitOf(r, cells, layout));
  }
  return { units, total: total || totalizeUnits(units) };
}

/** 전형명 뒤에 붙는 '경쟁률 현황', '[☞ 원서접수 바로가기]' 같은 안내 문구를 떼어낸다. */
function cleanTitle(s) {
  return String(s)
    .replace(/\[\s*[☞▶>]?[^[\]]*(바로가기|안내|보기)\s*\]/g, '')
    .replace(/\s*경쟁률\s*현황\s*$/, '')
    .trim();
}

/** id 가 prefix 로 시작하는 <div> 들을 "다음 div 시작 전"까지 블록으로 잘라낸다. */
function splitBlocks(doc, prefix) {
  const re = new RegExp(`<div\\s+id=['"]?(${prefix}[A-Za-z0-9_-]+)['"]?[^>]*>`, 'gi');
  const marks = [];
  let m;
  while ((m = re.exec(doc)) !== null) marks.push({ code: m[1].slice(prefix.length), start: m.index + m[0].length });
  return marks.map((mk, i) => ({
    code: mk.code,
    html: doc.slice(mk.start, i + 1 < marks.length ? marks[i + 1].start : doc.length),
  }));
}

/** 전형별 요약표(모집단위 없이 전형명만 있는 표) */
function parseSummaryTable(block) {
  const grid = tableGrid(block);
  const layout = headerLayout(grid);
  const items = [];
  let total = null;
  for (const { cells, spans } of grid) {
    const r = pickRow(cells, spans, layout);
    if (!r) continue;
    if (isTotalRow(r, cells)) total = { quota: r.quota, applied: r.applied, ratio: r.ratio };
    else items.push({ name: r.names.join(' ').trim(), quota: r.quota, applied: r.applied, ratio: r.ratio });
  }
  return { items, total: total || totalize(items) };
}

/**
 * 전형을 가로로 늘어놓은 교차표(전문대에서 흔함).
 *   1행: 모집단위 | 전형A(3칸) | 전형B(3칸) | …
 *   2행:          | 모집인원 지원인원 경쟁률 | …
 * 전형마다 별도 그룹으로 풀어낸다.
 */
function parseCrossTable(table) {
  const grid = tableGrid(table);
  const heads = grid.filter((r) => r.allHeader);
  if (heads.length < 2) return [];
  const [top, sub] = heads;

  const ratioCols = sub.cells.map((c, i) => (RATIO_HEADER.test(c) ? i : -1)).filter((i) => i >= 0);
  if (ratioCols.length < 2) return []; // 전형이 하나면 일반 표로 처리하는 편이 낫다
  const unitIdx = sub.cells.findIndex((c) => UNIT_HEADER.test(c));
  const nameIdx = unitIdx >= 0 ? unitIdx : top.cells.findIndex((c) => UNIT_HEADER.test(c));

  const groups = ratioCols.map((rIdx) => {
    // 전형명은 윗 행에서 이 컬럼 왼쪽의 가장 가까운 값
    let name = '';
    for (let k = rIdx; k >= 0; k--) {
      if (top.cells[k] && !UNIT_HEADER.test(top.cells[k])) { name = top.cells[k]; break; }
    }
    return { code: '', name: name.trim(), rIdx, units: [], total: null };
  });

  for (const { cells, spans, allHeader } of grid) {
    if (allHeader) continue;
    const unit = (cells[nameIdx >= 0 ? nameIdx : 0] || '').trim();
    // 캠퍼스별 소계·총계 행은 모집단위가 아니다(총계 칸이 colspan 으로 앞줄에 올 수 있어 행 전체를 본다).
    const totalRow = cells.slice(0, ratioCols[0] - 2).some((c) => TOTAL_TEXT.test(c.trim()));
    for (const g of groups) {
      const quota = asCount(cells[g.rIdx - 2]);
      const applied = asCount(cells[g.rIdx - 1]);
      const ratio = asRatio(cells[g.rIdx]);
      if (quota === null || applied === null || ratio === null) continue;
      if (totalRow) g.total = { quota, applied, ratio };
      else {
        g.units.push({
          unit,
          college: '',
          quota,
          applied,
          ratio,
          quotaShared: Boolean(spans && spans[g.rIdx - 2]),
          appliedShared: Boolean(spans && spans[g.rIdx - 1]),
        });
      }
    }
  }

  return groups
    .filter((g) => g.units.length || g.total)
    .map((g) => ({ code: g.code, name: g.name, total: g.total || totalizeUnits(g.units), units: g.units }));
}

/* ------------------------------------------------------------------ */
/* 진학어플라이                                                        */
/* ------------------------------------------------------------------ */
function parseJinhak(html) {
  const doc = stripScripts(html);

  const univ = textOf((/<title>([\s\S]*?)<\/title>/i.exec(doc) || ['', ''])[1])
    .replace(/경쟁률\s*서비스$/, '')
    .trim();
  const year = textOf((/id="TitleYear"[^>]*>([\s\S]*?)</i.exec(doc) || ['', ''])[1]);
  const category = textOf((/id="TitleService"[^>]*>([\s\S]*?)</i.exec(doc) || ['', ''])[1]);
  const updatedAt = textOf((/id="RatioTime"[^>]*>([\s\S]*?)<\/p>/i.exec(doc) || ['', ''])[1]);
  const notice = textOf((/id="TopType"[^>]*>([\s\S]*?)<\/ul>/i.exec(doc) || ['', ''])[1]);

  // 전형 코드 → 전형명 (상단 select)
  const typeNames = new Map();
  const sel = /<select[^>]*id="selType"[\s\S]*?<\/select>/i.exec(doc);
  if (sel) {
    const optRe = /<option[^>]*value="([^"]+)"[^>]*>([\s\S]*?)<\/option>/gi;
    let o;
    while ((o = optRe.exec(sel[0])) !== null) {
      if (o[1] !== '0') typeNames.set(o[1], textOf(o[2]));
    }
  }

  // 전형별 요약표
  let summary = null;
  let summaryItems = [];
  const sumTable = /<table[^>]*class="tableRatio2"[\s\S]*?<\/table>/i.exec(doc);
  if (sumTable) {
    const parsed = parseSummaryTable(sumTable[0]);
    summary = parsed.total;
    summaryItems = parsed.items;
  }

  // 전형별 상세: <div id="SelType401"> … (전형 코드에 영문이 섞이는 대학도 있다)
  const groups = [];
  for (const { code, html: block } of splitBlocks(doc, 'SelType')) {
    const title =
      cleanTitle(textOf((/<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block) || ['', ''])[1])) ||
      typeNames.get(code) ||
      code;
    const { units, total } = parseUnitTable(block);
    if (units.length || total) groups.push({ code, name: title.trim(), total, units });
  }

  // 전형 블록이 없는 대학: 전형을 가로로 늘어놓은 교차표를 쓰는 경우가 있다.
  if (!groups.length) {
    for (const table of doc.match(/<table[^>]*class="tableRatio3"[\s\S]*?<\/table>/gi) || []) {
      groups.push(...parseCrossTable(table));
    }
  }
  // 그래도 없으면 모집단위 상세 없이 전형별 요약만 제공하는 대학이다.
  if (!groups.length && summaryItems.length) {
    for (const it of summaryItems) {
      groups.push({
        code: '',
        name: it.name,
        total: { quota: it.quota, applied: it.applied, ratio: it.ratio },
        units: [],
      });
    }
  }

  return {
    source: 'jinhak',
    univ,
    year,
    category,
    updatedAt,
    notice,
    summary: summary || totalize(groups.map((g) => g.total)),
    groups,
  };
}

/* ------------------------------------------------------------------ */
/* 유웨이                                                              */
/* ------------------------------------------------------------------ */
function parseUway(html) {
  const doc = stripScripts(html);

  const univ = textOf((/<title>([\s\S]*?)<\/title>/i.exec(doc) || ['', ''])[1])
    .replace(/\//g, '')
    .replace(/경쟁률\s*서비스$/, '')
    .trim();
  const h2 = textOf((/<h2>([\s\S]*?)<\/h2>/i.exec(doc) || ['', ''])[1]);
  const year = (/(\d{4}학년도)/.exec(h2) || ['', ''])[1];
  const category =
    (/(수시\S*|정시\S*|편입\S*|추가\S*|재외\S*)/.exec(h2.replace(/^\d{4}학년도/, '')) || ['', ''])[1] || '';
  const updatedAt = textOf((/id=['"]ID_DateStr['"][^>]*>([\s\S]*?)<\/span>/i.exec(doc) || ['', ''])[1]);
  const notice = textOf((/id=['"]Ratio_Comment['"][^>]*>([\s\S]*?)<\/dl>/i.exec(doc) || ['', ''])[1]);

  // 전형 코드 → 전형명 (상단 select)
  const typeNames = new Map();
  const sel = /<select[^>]*name=['"]selectType['"][\s\S]*?<\/select>/i.exec(doc);
  if (sel) {
    const optRe = /<option[^>]*value=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/option>/gi;
    let o;
    while ((o = optRe.exec(sel[0])) !== null) typeNames.set(o[1], textOf(o[2]));
  }

  // 전형별 상세: <div id="Div_0001"> …
  const groups = [];
  for (const { code, html: block } of splitBlocks(doc, 'Div_')) {
    const title =
      cleanTitle(textOf((/<span[^>]*id=['"]strTitleId_[^'"]*['"][^>]*>([\s\S]*?)<\/span>/i.exec(block) || ['', ''])[1])) ||
      typeNames.get(code) ||
      code;
    const { units, total } = parseUnitTable(block);
    if (units.length || total) groups.push({ code, name: title.trim(), total, units });
  }

  // 모집단위 상세를 제공하지 않는 대학은 '전형별 경쟁률 현황' 요약표만 있다.
  if (!groups.length) {
    const i = doc.indexOf('strTitleId_TypeStat');
    if (i >= 0) {
      const t = /<table[\s\S]*?<\/table>/i.exec(doc.slice(i));
      if (t) {
        for (const it of parseSummaryTable(t[0]).items) {
          groups.push({
            code: '',
            name: it.name,
            total: { quota: it.quota, applied: it.applied, ratio: it.ratio },
            units: [],
          });
        }
      }
    }
  }

  // 캠퍼스별로 페이지가 나뉜 대학은 링크만 있는 허브 페이지가 온다.
  const children = [];
  if (!groups.length) {
    const linkRe = /href\s*=\s*["']?(https?:\/\/ratio\.uwayapply\.com\/[^"'\s>]+)/gi;
    let l;
    while ((l = linkRe.exec(doc)) !== null) {
      const u = l[1].replace(/^http:/, 'https:');
      if (!children.includes(u)) children.push(u);
    }
  }

  // 전체 총계: '전체 경쟁률 현황' 표의 총계 행을 우선한다.
  let summary = null;
  const ti = doc.indexOf('strTitleId_TotalStat');
  if (ti >= 0) {
    const t = /<table[\s\S]*?<\/table>/i.exec(doc.slice(ti));
    if (t) summary = parseSummaryTable(t[0]).total;
  }

  return {
    source: 'uway',
    univ,
    year,
    category,
    updatedAt,
    notice,
    summary: summary || totalize(groups.map((g) => g.total)),
    groups,
    ...(children.length ? { children } : {}),
  };
}

/** URL(또는 내용)을 보고 알맞은 파서를 고른다. */
function parseRatio(html, url) {
  if (/uwayapply\.com/i.test(url || '')) return parseUway(html);
  if (/jinhakapply\.com/i.test(url || '')) return parseJinhak(html);
  return /id=['"]?(Div_\d|Tr_Sum_0)/.test(html) ? parseUway(html) : parseJinhak(html);
}

/** 결과를 스프레드시트용 평면 행 배열로 변환 */
function flatten(result, meta = {}) {
  const rows = [];
  const base = {
    대학: meta.univ || result.univ,
    학년도: result.year,
    모집시기: result.category,
    기준시각: result.updatedAt,
  };
  for (const g of result.groups) {
    if (g.units.length) {
      for (const u of g.units) {
        rows.push({
          ...base,
          전형: g.name,
          계열: u.college,
          모집단위: u.unit,
          모집인원: u.quota,
          지원인원: u.applied,
          경쟁률: u.ratio,
        });
      }
    } else if (g.total) {
      rows.push({
        ...base,
        전형: g.name,
        계열: '',
        모집단위: '(전형 합계)',
        모집인원: g.total.quota,
        지원인원: g.total.applied,
        경쟁률: g.total.ratio,
      });
    }
  }
  return rows;
}

module.exports = { parseRatio, parseJinhak, parseUway, flatten, tableGrid, textOf, totalize };
