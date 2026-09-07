'use strict';
/**
 * HTML 가져오기 + 한글 인코딩 처리.
 * 유웨이 경쟁률 페이지는 EUC-KR, 진학어플라이는 UTF-8이라 응답 헤더/meta를 보고 디코딩한다.
 * (Node 18+ 내장 fetch와 full-icu TextDecoder만 사용 — 외부 의존성 없음)
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function charsetFrom(contentType, buf) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (fromHeader) return fromHeader[1].toLowerCase();
  // meta 태그는 ASCII 범위라 latin1로 훑어도 안전하다.
  const head = Buffer.from(buf).subarray(0, 4096).toString('latin1');
  const fromMeta = /charset=["']?([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1].toLowerCase() : 'utf-8';
}

function decode(buf, charset) {
  const cs = /euc-?kr|ks_c_5601|cp949|ksc5601/i.test(charset) ? 'euc-kr' : charset || 'utf-8';
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return Buffer.from(buf).toString('utf8');
  }
}

async function fetchText(url, { timeout = 15000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        redirect: 'follow',
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      return decode(buf, charsetFrom(res.headers.get('content-type'), buf));
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

module.exports = { fetchText, UA };
