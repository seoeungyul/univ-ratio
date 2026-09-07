'use strict';
/**
 * 대학 경쟁률 API 서버 (의존성 없음 — Node 18 이상이면 바로 실행)
 *
 *   node server.js            # http://localhost:8080
 *   PORT=3000 node server.js
 *
 * 엔드포인트
 *   GET /api/universities?q=한양&category=수시&provider=jinhak
 *       → 대학 목록/검색 (경쟁률 페이지 주소 포함)
 *   GET /api/ratio?univ=한양대학교(서울)
 *   GET /api/ratio?url=https://addon.jinhakapply.com/RatioV1/RatioH/Ratio11640591.html
 *       → 전형·모집단위별 경쟁률 (opts: all=1 이면 동명 대학 전부)
 *   GET /api/ratio.csv?univ=한양대학교(서울)
 *       → 스프레드시트에 붙여넣기 좋은 CSV
 *   GET /api/health
 */

const http = require('node:http');
const { getIndex, getRatioByName, getRatioByUrl } = require('./src/service');
const { flatten } = require('./src/parser');
const { searchIndex } = require('./src/sources');

const PORT = Number(process.env.PORT || 8080);
const ALLOWED_HOSTS = /(^|\.)(jinhakapply\.com|uwayapply\.com)$/i;

const json = (res, status, body) => {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=60',
  });
  res.end(text);
};

const csv = (res, rows) => {
  const cols = ['대학', '학년도', '모집시기', '전형', '계열', '모집단위', '모집인원', '지원인원', '경쟁률', '기준시각'];
  const esc = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end('﻿' + body); // 엑셀에서 한글이 깨지지 않도록 BOM
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const q = url.searchParams;

  try {
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    }

    if (url.pathname === '/api/universities') {
      const index = await getIndex();
      const keyword = q.get('q');
      let list = keyword
        ? searchIndex(index, keyword, { currentOnly: q.get('all') !== '1' })
        : index.filter((it) => q.get('all') === '1' || it.current);
      if (q.get('category')) list = list.filter((it) => (it.category || '').includes(q.get('category')));
      if (q.get('provider')) list = list.filter((it) => it.provider === q.get('provider'));
      return json(res, 200, { count: list.length, universities: list });
    }

    if (url.pathname === '/api/ratio' || url.pathname === '/api/ratio.csv') {
      const univ = q.get('univ') || q.get('name');
      const target = q.get('url');
      let result;

      if (target) {
        // 외부 URL 프록시로 악용되지 않도록 두 사이트만 허용한다.
        let host;
        try {
          host = new URL(target).hostname;
        } catch {
          return json(res, 400, { error: 'url 형식이 올바르지 않습니다.' });
        }
        if (!ALLOWED_HOSTS.test(host)) {
          return json(res, 400, { error: '진학어플라이/유웨이 경쟁률 주소만 조회할 수 있습니다.' });
        }
        result = await getRatioByUrl(target);
      } else if (univ) {
        result = await getRatioByName(univ, {
          category: q.get('category') || undefined,
          provider: q.get('provider') || undefined,
          all: q.get('all') === '1',
          currentOnly: q.get('past') !== '1',
        });
      } else {
        return json(res, 400, { error: 'univ 또는 url 파라미터가 필요합니다.' });
      }

      if (url.pathname.endsWith('.csv')) {
        const list = Array.isArray(result) ? result : [result];
        const rows = list.flatMap((r) => (r.groups ? flatten(r, { univ: r.matched ? r.matched.univ : r.univ }) : []));
        return csv(res, rows);
      }
      return json(res, 200, result);
    }

    return json(res, 404, { error: 'not found', endpoints: ['/api/universities', '/api/ratio', '/api/ratio.csv'] });
  } catch (e) {
    const status = e.status || 502;
    return json(res, status, { error: e.message, ...(e.suggestions ? { suggestions: e.suggestions } : {}) });
  }
});

server.listen(PORT, () => {
  console.log(`경쟁률 API 서버: http://localhost:${PORT}`);
  console.log(`  예) http://localhost:${PORT}/api/ratio?univ=${encodeURIComponent('한양대학교(서울)')}`);
});
