'use strict';
/**
 * 대학 목록 색인과 경쟁률 조회를 묶은 서비스 계층.
 * 두 사이트 모두 10분~1시간 단위로만 갱신되므로 메모리에 짧게 캐시해 재요청을 줄인다.
 */

const { fetchText } = require('./fetch');
const { fetchIndex, searchIndex } = require('./sources');
const { parseRatio, flatten } = require('./parser');

const INDEX_TTL = 30 * 60 * 1000; // 대학 목록: 30분
const RATIO_TTL = 5 * 60 * 1000; //  경쟁률: 5분

const cache = new Map();

async function cached(key, ttl, loader) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttl) return hit.value;
  try {
    const value = await loader();
    cache.set(key, { at: now, value });
    return value;
  } catch (e) {
    if (hit) return hit.value; // 일시적 장애면 조금 지난 값이라도 돌려준다
    throw e;
  }
}

const getIndex = () => cached('index', INDEX_TTL, fetchIndex);

/** 경쟁률 URL 하나를 가져와 파싱 */
const getRatioByUrl = (url) =>
  cached(`ratio:${url}`, RATIO_TTL, async () => {
    const html = await fetchText(url);
    return { ...parseRatio(html, url), url };
  });

class NotFound extends Error {
  constructor(message, extra) {
    super(message);
    this.status = 404;
    Object.assign(this, extra || {});
  }
}

/**
 * 대학명으로 경쟁률 조회.
 * @param {string} name  '한양대', '중앙대학교' 처럼 부분 이름도 된다
 * @param {object} opts  { category: '수시모집', provider: 'jinhak'|'uway', all: true }
 */
async function getRatioByName(name, opts = {}) {
  const index = await getIndex();
  const hits = searchIndex(index, name, { ...opts, currentOnly: opts.currentOnly !== false });

  if (!hits.length) {
    const loose = searchIndex(index, name, {});
    throw new NotFound(`'${name}' 에 해당하는 대학을 찾지 못했습니다.`, {
      suggestions: loose.slice(0, 5).map((h) => h.univ),
    });
  }
  if (hits.length > 1 && !opts.all) {
    // 캠퍼스가 나뉜 대학 등은 어느 쪽인지 알려주고 첫 번째를 돌려준다.
    const target = hits[0];
    const result = await getRatioByUrl(target.ratioUrl);
    return { ...result, matched: target, candidates: hits.map((h) => h.univ) };
  }

  if (opts.all) {
    const results = [];
    for (const h of hits) {
      try {
        results.push({ ...(await getRatioByUrl(h.ratioUrl)), matched: h });
      } catch (e) {
        results.push({ matched: h, error: e.message });
      }
    }
    return results;
  }

  const target = hits[0];
  return { ...(await getRatioByUrl(target.ratioUrl)), matched: target };
}

/** 여러 대학을 한 번에 (스프레드시트 갱신용) */
async function getManyFlat(names, opts = {}) {
  const rows = [];
  const errors = [];
  for (const name of names) {
    try {
      const r = await getRatioByName(name, opts);
      rows.push(...flatten(r, { univ: r.matched ? r.matched.univ : r.univ }));
    } catch (e) {
      errors.push({ name, error: e.message });
    }
  }
  return { rows, errors };
}

module.exports = { getIndex, getRatioByUrl, getRatioByName, getManyFlat, NotFound, cache };
