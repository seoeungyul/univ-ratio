/**
 * 대학 경쟁률 가져오기 — Google Apps Script (단일 파일, 라이브러리 불필요)
 *
 *   진학어플라이  https://apply.jinhakapply.com/SmartRatio
 *   유웨이 파워경쟁률 https://info.uway.com/power/?isApply=1
 * 두 곳의 대학 목록을 합쳐 색인을 만들고, 각 대학의 경쟁률 페이지를 파싱한다.
 *
 * ── 쓰는 법 ────────────────────────────────────────────────
 *  1) 스프레드시트 → 확장 프로그램 → Apps Script 에 이 파일을 붙여넣는다.
 *  2) 시트 '설정' A열에 원하는 대학명을 적는다. (없으면 아래 DEFAULT_UNIVS 사용)
 *  3) updateRatioSheet 를 한 번 실행해 권한을 허용한다.
 *  4) installHourlyTrigger 를 실행하면 1시간마다 자동 갱신된다.
 *
 *  시트 함수로도 쓸 수 있다:
 *     =RATIO("한양대학교(서울)")            → 전체 경쟁률 (모집인원/지원인원/경쟁률)
 *     =RATIO("중앙대","소프트웨어")          → 특정 모집단위만
 *     =RATIO_TABLE("가천대학교")            → 전형·모집단위 표 전체
 *     =RATIO_UNIV_LIST("한양")             → 대학 검색
 * ───────────────────────────────────────────────────────────
 */

/** 시트에 '설정'이 없을 때 사용할 기본 대학 목록 */
var DEFAULT_UNIVS = ['한양대학교(서울)', '중앙대학교', '가천대학교'];

var SHEET_DATA = '경쟁률';
var SHEET_CONFIG = '설정';
var CACHE_SECONDS = 300; // 같은 페이지 재요청 방지 (초)

var JINHAK_INDEX = 'https://apply.jinhakapply.com/SmartRatio';
var UWAY_INDEX = 'https://info.uway.com/power/?isApply=1';

/* ══════════════════════════════════════════════════════════
 *  1. 메뉴 · 트리거
 * ══════════════════════════════════════════════════════════ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('경쟁률')
    .addItem('지금 갱신', 'updateRatioSheet')
    .addItem('1시간마다 자동 갱신 켜기', 'installHourlyTrigger')
    .addItem('자동 갱신 끄기', 'removeTriggers')
    .addToUi();
}

function installHourlyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('updateRatioSheet').timeBased().everyHours(1).create();
  SpreadsheetApp.getActive().toast('1시간마다 자동 갱신합니다.');
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'updateRatioSheet') ScriptApp.deleteTrigger(t);
  });
}

/* ══════════════════════════════════════════════════════════
 *  2. 시트 갱신
 * ══════════════════════════════════════════════════════════ */

/** 설정 시트(또는 DEFAULT_UNIVS)의 대학들을 조회해 '경쟁률' 시트에 기록한다. */
function updateRatioSheet() {
  var ss = SpreadsheetApp.getActive();
  var names = readTargetUniversities_(ss);
  if (!names.length) throw new Error("조회할 대학이 없습니다. '설정' 시트 A열에 대학명을 적어주세요.");

  var header = ['대학', '학년도', '모집시기', '전형', '계열', '모집단위', '모집인원', '지원인원', '경쟁률', '기준시각'];
  var rows = [];
  var errors = [];

  names.forEach(function (name) {
    try {
      var r = fetchRatioByName(name);
      rows = rows.concat(flattenRatio(r, r.matched ? r.matched.univ : r.univ));
    } catch (e) {
      errors.push(name + ': ' + e.message);
    }
  });

  var sheet = ss.getSheetByName(SHEET_DATA) || ss.insertSheet(SHEET_DATA);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) {
    var values = rows.map(function (r) {
      return header.map(function (h) {
        return r[h];
      });
    });
    sheet.getRange(2, 1, values.length, header.length).setValues(values);
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, header.length);

  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  var msg = rows.length + '행 갱신 (' + stamp + ')';
  if (errors.length) msg += ' / 실패: ' + errors.join(', ');
  ss.toast(msg, '경쟁률', 10);
  return msg;
}

function readTargetUniversities_(ss) {
  var sheet = ss.getSheetByName(SHEET_CONFIG);
  if (!sheet) return DEFAULT_UNIVS.slice();
  var last = sheet.getLastRow();
  if (last < 1) return DEFAULT_UNIVS.slice();
  return sheet
    .getRange(1, 1, last, 1)
    .getValues()
    .map(function (r) {
      return String(r[0] || '').trim();
    })
    .filter(function (v) {
      return v && v !== '대학명' && v !== '대학';
    });
}

/* ══════════════════════════════════════════════════════════
 *  3. 시트 함수 (커스텀 함수)  — 기존 RATIO / RATIO_TABLE 을 이 블록으로 교체
 *
 *   =RATIO("평택대")                                        → 전체 합계 3칸
 *   =RATIO("평택대", , "PTU교과")                            → 그 전형의 합계 3칸
 *   =RATIO("평택대","AI소프트웨어학과")                       → 전형별 표 (5열)
 *   =RATIO("평택대","AI소프트웨어학과","PTU교과")             → 16 | 5 | 0.31  (3칸)
 *   =RATIO("평택대","AI소프트웨어학과","PTU교과","경쟁률")     → 0.31        (1칸)
 *
 *   =RATIO_TYPES("평택대")                                  → 전형 이름 목록
 *   =RATIO_TABLE("평택대","PTU")                            → 전형 필터 가능
 * ══════════════════════════════════════════════════════════ */

/** 이름 비교용 정규화 (공백·괄호·하이픈 무시) */
function ratioKey_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/[\s()（）·・.\-_]/g, '')
    .toLowerCase();
}

/** '경쟁률' 같은 값 이름 → 열 번호(0:모집인원 1:지원인원 2:경쟁률). 없으면 -1, 모르면 -2 */
function ratioField_(field) {
  if (field === undefined || field === null || field === '') return -1;
  var k = ratioKey_(field);
  var map = { 모집인원: 0, 모집: 0, 정원: 0, 지원인원: 1, 지원: 1, 접수인원: 1, 경쟁률: 2, 경쟁: 2, 배수: 2 };
  for (var name in map) if (ratioKey_(name) === k) return map[name];
  return -2;
}

function ratioCut_(rows, idx) {
  return idx < 0
    ? rows
    : rows.map(function (r) {
        return [r[idx]];
      });
}

/** 전형명으로 그룹 고르기 — 완전 일치 우선, 없으면 부분 일치 */
function ratioPickGroups_(groups, tKey) {
  var exact = groups.filter(function (g) {
    return ratioKey_(g.name) === tKey;
  });
  if (exact.length) return exact;
  return groups.filter(function (g) {
    return ratioKey_(g.name).indexOf(tKey) >= 0;
  });
}

function ratioTotalOf_(g) {
  return g.total || totalizeUnits(g.units);
}

/**
 * 대학·모집단위·전형별 경쟁률.
 * @param {string} univ  대학명 (부분 이름 가능)
 * @param {string} unit  모집단위명 (생략 가능)
 * @param {string} type  전형명 (생략 가능, 부분 이름 가능)
 * @param {string} field '모집인원' | '지원인원' | '경쟁률' 중 하나만 뽑을 때 (생략 가능)
 * @return {Array} 표
 * @customfunction
 */
function RATIO(univ, unit, type, field) {
  if (!univ) return '대학명을 입력하세요';

  var idx = ratioField_(field);
  if (idx === -2) return '네 번째 값은 모집인원 / 지원인원 / 경쟁률 중 하나입니다';

  var r = fetchRatioByName(String(univ));
  var uKey = ratioKey_(unit);
  var tKey = ratioKey_(type);

  var groups = r.groups;
  if (tKey) {
    groups = ratioPickGroups_(groups, tKey);
    if (!groups.length) return "'" + type + "' 전형을 찾지 못했습니다";
  }

  /* ── 모집단위를 안 적은 경우 ── */
  if (!uKey) {
    if (!tKey) {
      var s = r.summary;
      return s ? ratioCut_([[s.quota, s.applied, s.ratio]], idx) : '집계 없음';
    }
    var sums = [];
    groups.forEach(function (g) {
      var t = ratioTotalOf_(g);
      if (t) sums.push([g.name, t.quota, t.applied, t.ratio]);
    });
    if (!sums.length) return '집계 없음';
    // 전형 하나로 좁혀졌으면 이름 없이 숫자만
    if (sums.length === 1) return ratioCut_([sums[0].slice(1)], idx);
    return idx < 0
      ? sums
      : sums.map(function (x) {
          return [x[0], x[1 + idx]];
        });
  }

  /* ── 모집단위를 적은 경우 ── */
  var out = [];
  groups.forEach(function (g) {
    g.units.forEach(function (u) {
      if (ratioKey_(u.unit).indexOf(uKey) >= 0) out.push([g.name, u.unit, u.quota, u.applied, u.ratio]);
    });
  });
  if (!out.length) return "'" + unit + "' 모집단위를 찾지 못했습니다";

  // 전형까지 지정했으면 이름 칸을 빼고 숫자만 돌려준다 (한 줄이면 3칸)
  if (tKey) {
    return ratioCut_(
      out.map(function (x) {
        return x.slice(2);
      }),
      idx
    );
  }
  return idx < 0
    ? out
    : out.map(function (x) {
        return [x[0], x[1], x[2 + idx]];
      });
}

/**
 * 그 대학이 어떤 전형 이름을 쓰는지 확인용. (RATIO 세 번째 인자에 넣을 이름)
 * @param {string} univ 대학명
 * @return {Array} 표
 * @customfunction
 */
function RATIO_TYPES(univ) {
  if (!univ) return '대학명을 입력하세요';
  var r = fetchRatioByName(String(univ));
  var rows = [['전형', '모집인원', '지원인원', '경쟁률']];
  r.groups.forEach(function (g) {
    var t = ratioTotalOf_(g);
    rows.push([g.name, t ? t.quota : '', t ? t.applied : '', t ? t.ratio : '']);
  });
  return rows.length > 1 ? rows : '전형 정보가 없습니다';
}

/**
 * 전형·모집단위별 경쟁률 표 전체.
 * @param {string} univ 대학명
 * @param {string} type 전형명 (생략하면 전체)
 * @return {Array} 표
 * @customfunction
 */
function RATIO_TABLE(univ, type) {
  if (!univ) return '대학명을 입력하세요';
  var r = fetchRatioByName(String(univ));

  var groups = r.groups;
  var tKey = ratioKey_(type);
  if (tKey) {
    groups = ratioPickGroups_(groups, tKey);
    if (!groups.length) return "'" + type + "' 전형을 찾지 못했습니다";
  }

  var rows = [['전형', '계열', '모집단위', '모집인원', '지원인원', '경쟁률']];
  groups.forEach(function (g) {
    if (g.units.length) {
      g.units.forEach(function (u) {
        rows.push([g.name, u.college, u.unit, u.quota, u.applied, u.ratio]);
      });
    } else if (g.total) {
      rows.push([g.name, '', '(전형 합계)', g.total.quota, g.total.applied, g.total.ratio]);
    }
  });
  return rows;
}

/**
 * 대학 검색 — 이름과 경쟁률 페이지 주소를 돌려준다. (기존과 동일)
 * @param {string} keyword 검색어
 * @return {Array} 표
 * @customfunction
 */
function RATIO_UNIV_LIST(keyword) {
  var list = fetchUnivIndex();
  var q = normalizeName_(keyword || '');
  var hits = q
    ? list.filter(function (it) {
        return normalizeName_(it.univ).indexOf(q) >= 0;
      })
    : list;
  var rows = [['대학', '모집시기', '지역', '접수마감', '제공', '경쟁률주소']];
  hits.slice(0, 200).forEach(function (it) {
    rows.push([it.univ, it.category, it.region, it.applyTo, it.provider, it.ratioUrl]);
  });
  return rows;
}
/* ══════════════════════════════════════════════════════════
 *  4. 가져오기 (UrlFetchApp + 캐시)
 * ══════════════════════════════════════════════════════════ */

/** 페이지를 가져와 한글 인코딩(진학=UTF-8, 유웨이=EUC-KR)에 맞게 디코딩한다. */
function fetchHtml_(url) {
  var cache = CacheService.getScriptCache();
  var key = 'html_' + Utilities.base64EncodeWebSafe(url).slice(0, 200);
  var hit = cache.get(key);
  if (hit) return hit;

  var res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('HTTP ' + code + ' — ' + url);

  var ctype = res.getHeaders()['Content-Type'] || res.getHeaders()['content-type'] || '';
  var charset = /charset=["']?([\w-]+)/i.exec(ctype);
  var enc = charset ? charset[1].toUpperCase() : '';
  if (!enc) {
    // 헤더에 없으면 meta 태그를 본다 (meta 는 ASCII 범위라 UTF-8 로 읽어도 안전)
    var head = res.getContentText('UTF-8').slice(0, 4096);
    var meta = /charset=["']?([\w-]+)/i.exec(head);
    enc = meta ? meta[1].toUpperCase() : 'UTF-8';
  }
  if (/EUC-?KR|KS_C_5601|CP949/i.test(enc)) enc = 'EUC-KR';

  var html;
  try {
    html = res.getContentText(enc);
  } catch (e) {
    html = res.getContentText('UTF-8');
  }
  // 캐시 한도(100KB)를 넘는 페이지는 캐시하지 않는다.
  if (html.length < 90000) {
    try {
      cache.put(key, html, CACHE_SECONDS);
    } catch (e) {}
  }
  return html;
}

/** 진학어플라이 + 유웨이 대학 목록을 합친 색인 */
function fetchUnivIndex() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('univ_index');
  if (hit) {
    try {
      return JSON.parse(hit);
    } catch (e) {}
  }

  var all = [];
  try {
    all = all.concat(fetchJinhakIndex_());
  } catch (e) {}
  try {
    all = all.concat(fetchUwayIndex_());
  } catch (e) {}
  if (!all.length) throw new Error('대학 목록을 가져오지 못했습니다.');

  var seen = {};
  var out = [];
  all.forEach(function (it) {
    if (!it.univ) return;
    var key = it.univ + '|' + it.ratioUrl;
    if (seen[key] && it.index !== 'jinhak') return;
    if (!seen[key]) out.push(it);
    seen[key] = true;
  });
  out.sort(function (a, b) {
    return a.univ < b.univ ? -1 : a.univ > b.univ ? 1 : 0;
  });

  try {
    cache.put('univ_index', JSON.stringify(out), 1800);
  } catch (e) {} // 100KB 초과 시 캐시 생략
  return out;
}

function decodeEntities_(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function providerOf_(url) {
  if (/uwayapply\.com/i.test(url)) return 'uway';
  if (/jinhakapply\.com/i.test(url)) return 'jinhak';
  return 'etc';
}

/** 유웨이 목록의 래퍼 주소에서 실제 경쟁률 주소를 꺼낸다. */
function unwrapRatioUrl_(url) {
  var m = /[?&]ratioURL=([^&]+)/i.exec(url || '');
  if (!m) return url;
  var inner = decodeURIComponent(m[1]);
  if (inner.indexOf('//') === 0) inner = 'https:' + inner;
  return inner;
}

/** 진학어플라이 SmartRatio: hidden input 안에 전 대학 목록이 JSON 으로 들어있다. */
function fetchJinhakIndex_() {
  var html = fetchHtml_(JINHAK_INDEX);
  var out = [];
  ['hdnResultNow', 'hdnResultPast'].forEach(function (id) {
    var m = new RegExp('id="' + id + '"[^>]*value="([\\s\\S]*?)"\\s*/?>', 'i').exec(html);
    if (!m) return;
    var data;
    try {
      data = JSON.parse(decodeEntities_(m[1]));
    } catch (e) {
      return;
    }
    var cols = data.Columns || [];
    (data.Rows || []).forEach(function (row) {
      var o = {};
      cols.forEach(function (c, i) {
        o[c] = row[i];
      });
      var link = String(o.RatioLink || '').trim();
      if (!link || link.length < 10) return; // 전각공백으로 채워진 미제공 행
      out.push({
        univ: String(o.UnivName || '').trim(),
        univType: o.UnivType,
        category: o.CategoryDisplayName || o.CategoryName || '',
        region: o.PresidentName || '',
        establishment: o.SpecialCode || '',
        year: o.SchoolYear,
        applyFrom: o.ApplyFromTime || '',
        applyTo: o.ApplyToTime || '',
        applyLink: o.WonseoLink || '',
        ratioUrl: link,
        provider: providerOf_(link),
        index: 'jinhak',
        current: id === 'hdnResultNow',
      });
    });
  });
  return out;
}

/** 유웨이 파워경쟁률: <tr data-state="…"> 표를 서버에서 그려 내려준다. */
function fetchUwayIndex_() {
  var html = fetchHtml_(UWAY_INDEX);
  var out = [];
  var trRe = /<tr\s+data-state=["']([^"']*)["'][^>]*>([\s\S]*?)<\/tr>/gi;
  var m;
  while ((m = trRe.exec(html)) !== null) {
    var state = m[1];
    var body = m[2];
    var abbrs = [];
    var tds = [];
    var tdRe = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
    var t;
    while ((t = tdRe.exec(body)) !== null) {
      var a = /abbr=["']([^"']*)["']/i.exec(t[1]);
      abbrs.push(a ? decodeEntities_(a[1]).trim() : textOf(t[2]));
      tds.push(t[2]);
    }
    var last = tds[tds.length - 1] || '';
    var raw = (/href=["']([^"']+)["']/i.exec(last) || ['', ''])[1];
    if (!raw) continue;
    var link = unwrapRatioUrl_(decodeEntities_(raw));
    if (!/^https?:\/\//i.test(link)) continue; // 'javascript:void(0)' 등 실제 주소가 없는 행
    var period = abbrs[5] || '';
    var parts = period.split('~');
    out.push({
      univ: (abbrs[4] || '').trim(),
      univType: /전문/.test(abbrs[1] || '') ? 2 : 4,
      category: abbrs[1] || '',
      region: abbrs[2] || '',
      establishment: abbrs[3] || '',
      applyFrom: (parts[0] || '').trim(),
      applyTo: (parts[1] || '').trim(),
      applyLink: (/href=["']([^"']+)["']/i.exec(tds[4] || '') || ['', ''])[1],
      ratioUrl: link.replace(/^http:/, 'https:'),
      provider: providerOf_(link),
      index: 'uway',
      current: /접수중/.test(state),
      state: state,
    });
  }
  return out;
}

function normalizeName_(s) {
  return String(s || '')
    .replace(/[\s()（）·・.]/g, '')
    .toLowerCase();
}

/** 대학명으로 경쟁률 조회 */
function fetchRatioByName(name, opts) {
  opts = opts || {};
  var index = fetchUnivIndex();
  var q = normalizeName_(name);
  var hits = index.filter(function (it) {
    // provider 'etc' 는 대학 홈페이지에서 자체 제공하는 경우라 파싱 대상이 아니다.
    return (
      normalizeName_(it.univ).indexOf(q) >= 0 &&
      it.provider !== 'etc' &&
      (opts.includePast || it.current)
    );
  });
  if (opts.category) {
    hits = hits.filter(function (it) {
      return (it.category || '').indexOf(opts.category) >= 0;
    });
  }
  if (!hits.length) throw new Error("'" + name + "' 에 해당하는 대학을 찾지 못했습니다.");

  // 완전 일치를 먼저
  hits.sort(function (a, b) {
    return (normalizeName_(b.univ) === q ? 1 : 0) - (normalizeName_(a.univ) === q ? 1 : 0);
  });

  var target = hits[0];
  var result = parseRatio(fetchHtml_(target.ratioUrl), target.ratioUrl);
  result.matched = target;
  result.url = target.ratioUrl;
  return result;
}

/** 경쟁률 주소로 바로 조회 */
function fetchRatioByUrl(url) {
  var r = parseRatio(fetchHtml_(url), url);
  r.url = url;
  return r;
}

/** 결과를 시트용 평면 행으로 */
function flattenRatio(result, univName) {
  var rows = [];
  result.groups.forEach(function (g) {
    if (g.units.length) {
      g.units.forEach(function (u) {
        rows.push({
          대학: univName || result.univ,
          학년도: result.year,
          모집시기: result.category,
          전형: g.name,
          계열: u.college,
          모집단위: u.unit,
          모집인원: u.quota,
          지원인원: u.applied,
          경쟁률: u.ratio,
          기준시각: result.updatedAt,
        });
      });
    } else if (g.total) {
      rows.push({
        대학: univName || result.univ,
        학년도: result.year,
        모집시기: result.category,
        전형: g.name,
        계열: '',
        모집단위: '(전형 합계)',
        모집인원: g.total.quota,
        지원인원: g.total.applied,
        경쟁률: g.total.ratio,
        기준시각: result.updatedAt,
      });
    }
  });
  return rows;
}

/* ══════════════════════════════════════════════════════════
 *  5. HTML 파서 — 아래는 사이트 구조에 맞춘 파싱 로직이다.
 *     (Node 서버판 src/parser.js 와 동일한 알고리즘)
 * ══════════════════════════════════════════════════════════ */

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

