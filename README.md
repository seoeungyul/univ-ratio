# 대학 경쟁률 가져오기

진학어플라이 [SmartRatio](https://apply.jinhakapply.com/SmartRatio) 와 유웨이 [파워경쟁률](https://info.uway.com/power/?isApply=1)
에서 원하는 대학의 전형·모집단위별 경쟁률을 가져온다.

- **API 서버** — `server.js` (Node 18+, 외부 패키지 없음)
- **Google Apps Script** — `gas/경쟁률.gs` (단일 파일, 스프레드시트에 붙여넣으면 끝)

두 곳 모두 같은 파싱 알고리즘을 쓴다.

---

## 어떻게 가져오는가

두 사이트 모두 공개 API가 없어서 목록 페이지에 실려 오는 데이터를 읽는다.

| | 대학 목록 | 경쟁률 페이지 |
|---|---|---|
| 진학어플라이 | `SmartRatio` 페이지의 `<input id="hdnResultNow">` 안에 **전 대학 목록이 JSON**으로 들어있다 | `addon.jinhakapply.com/RatioV1/RatioH/Ratio{코드}.html` (UTF-8) |
| 유웨이 | 파워경쟁률 페이지의 `<tr data-state="접수중">` 표 (서버 렌더링) | `ratio.uwayapply.com/{인코딩된키}` (EUC-KR) |

두 목록에는 서로의 대학이 섞여 들어 있어(유웨이 목록에도 진학사 접수 대학이 있다) 합쳐서 하나의 색인으로 쓴다.
경쟁률 주소의 도메인으로 어느 쪽 파서를 쓸지 정한다.

### 파싱이 까다로운 지점

대학마다 표 구성이 제각각이라 단순한 "N번째 칸" 규칙은 통하지 않는다. `src/parser.js` 는 이렇게 처리한다.

1. **표를 그리드로 펼친다** — `rowspan`/`colspan` 을 실제 칸으로 전개한다.
   통합모집(여러 학과가 모집인원 한 칸을 공유)이 흔해서, 펼치지 않으면 뒤따르는 학과 행이 통째로 사라진다.
   병합으로 내려온 칸은 `quotaShared`/`appliedShared` 로 표시해 합계에서 중복으로 세지 않는다.
2. **컬럼을 헤더로 찾는다** — `<th>` 에서 `모집단위`/`모집인원`/`지원인원`/`경쟁률` 위치를 잡는다.
   경쟁률을 `0.30`처럼 `: 1` 없이 쓰는 대학도 이 방식으로 읽힌다.
3. **헤더가 없으면 역방향 매칭** — `"1.67 : 1"` 셀을 찾아 그 앞 두 칸을 인원으로 읽는다.
4. **소계·총계 행을 걸러낸다** — `회계학과`처럼 학과명에 '계'가 든 경우와 구분하기 위해 어미로만 판정한다.
5. **교차표도 지원** — 전문대에서 흔한 "모집단위 × 전형" 가로 배치 표는 전형별 그룹으로 풀어낸다.

### 실측 결과

`node test/validate.js` — 2026-09-08 기준 접수 중인 230개 대학 전수 조회:

```
파싱 성공          : 223
데이터 없음        :   4   (서비스 오픈 전 / 캠퍼스별 링크 안내 페이지)
조회 실패          :   3   (사이트가 아직 안 올린 페이지 → 404)
모집단위 행        : 36,575
합계 불일치 경고   :   7   (사이트가 값을 병합 표기한 표)
```

---

## API 서버

```bash
node server.js              # http://localhost:8080
PORT=3000 node server.js
```

### `GET /api/universities`

대학 목록·검색. 경쟁률 페이지 주소와 접수 기간이 함께 온다.

| 파라미터 | 설명 |
|---|---|
| `q` | 검색어 (공백·괄호 무시, 부분 일치) |
| `category` | `수시모집`, `정시모집` 등 |
| `provider` | `jinhak` / `uway` |
| `all=1` | 마감된 전형까지 포함 |

```bash
curl "http://localhost:8080/api/universities?q=한양"
```

```json
{
  "count": 3,
  "universities": [
    {
      "univ": "한양대학교(서울)",
      "category": "수시모집",
      "region": "서울",
      "applyTo": "2026-09-11T18:00:00",
      "ratioUrl": "https://addon.jinhakapply.com/RatioV1/RatioH/Ratio11640591.html",
      "provider": "jinhak"
    }
  ]
}
```

### `GET /api/ratio`

경쟁률 조회. `univ`(대학명) 또는 `url`(경쟁률 주소) 중 하나가 필요하다.

| 파라미터 | 설명 |
|---|---|
| `univ` | 대학명. `한양대` 처럼 일부만 써도 된다 |
| `url` | 경쟁률 페이지 주소를 직접 지정 (진학/유웨이 도메인만 허용) |
| `all=1` | 이름이 여럿 걸릴 때(캠퍼스 분리 등) 전부 조회 |
| `category`, `provider` | 후보 좁히기 |

```bash
curl "http://localhost:8080/api/ratio?univ=가톨릭관동대학교"
```

```json
{
  "source": "uway",
  "univ": "가톨릭관동대학교",
  "year": "2027학년도",
  "category": "수시모집",
  "updatedAt": "2026년 09월 08일 04시 20분 기준",
  "summary": { "quota": 1602, "applied": 1120, "ratio": 0.7 },
  "groups": [
    {
      "code": "0001",
      "name": "정원내 학생부교과(일반전형)",
      "total": { "quota": 769, "applied": 445, "ratio": 0.58 },
      "units": [
        {
          "unit": "의학과(의예과)",
          "college": "의과대학",
          "quota": 12,
          "applied": 20,
          "ratio": 1.67,
          "quotaShared": false,
          "appliedShared": false
        }
      ]
    }
  ]
}
```

`quotaShared` / `appliedShared` 가 `true` 면 그 값은 위 행에서 병합되어 내려온 값이다(통합모집).
합계를 직접 계산할 때는 이 행의 값을 빼야 중복되지 않는다.

### `GET /api/ratio.csv`

같은 데이터를 스프레드시트용 CSV로 준다 (엑셀 한글 깨짐 방지 BOM 포함).

```bash
curl "http://localhost:8080/api/ratio.csv?univ=가야대학교" -o 가야대.csv
```

```
대학,학년도,모집시기,전형,계열,모집단위,모집인원,지원인원,경쟁률,기준시각
가야대학교,2027학년도,수시모집,일반학생(정원내),,특수교육과,25,22,0.88,2026-09-08 오전 4:20 현황
```

### 참고

- 경쟁률 응답은 5분, 대학 목록은 30분 메모리 캐시한다 (사이트도 10분~1시간 단위로만 갱신된다).
- `url` 파라미터는 `jinhakapply.com` / `uwayapply.com` 만 허용한다 (오픈 프록시 방지).
- 상대 사이트에 부담을 주지 않도록 조회 간격을 너무 짧게 두지 않는 편이 좋다.

---

## Google Apps Script

`gas/경쟁률.gs` 를 스프레드시트의 **확장 프로그램 → Apps Script** 에 붙여넣는다. 라이브러리는 필요 없다.

1. `설정` 시트 A열에 원하는 대학명을 적는다 (시트가 없으면 파일 상단 `DEFAULT_UNIVS` 를 사용).
2. `updateRatioSheet` 를 한 번 실행해 권한을 허용한다 → `경쟁률` 시트가 생성된다.
3. `installHourlyTrigger` 를 실행하면 1시간마다 자동 갱신된다.
   (스프레드시트를 열면 상단에 **경쟁률** 메뉴도 생긴다.)

`appsscript.json` 의 `urlFetchWhitelist` 는 따로 설정할 필요가 없지만, 외부 요청 권한
(`https://www.googleapis.com/auth/script.external_request`)은 최초 실행 시 승인해야 한다.

### 시트 함수

| 함수 | 결과 |
|---|---|
| `=RATIO("한양대학교(서울)")` | `모집인원 · 지원인원 · 경쟁률` 한 줄 |
| `=RATIO("중앙대","소프트웨어")` | 이름에 '소프트웨어'가 든 모집단위들 |
| `=RATIO_TABLE("가천대학교")` | 전형·모집단위 표 전체 |
| `=RATIO_UNIV_LIST("한양")` | 대학 검색 (경쟁률 주소 포함) |

> 커스텀 함수는 결과를 최대 6분까지만 계산하고 캐시가 짧다. 대학이 많으면 함수보다
> `updateRatioSheet` + 시간 트리거 쪽이 안정적이다.

### 서버를 함께 쓰는 경우

API 서버를 이미 띄웠다면 GAS에서 CSV를 그대로 당겨올 수도 있다.

```js
function importFromApi() {
  var url = 'https://내서버/api/ratio.csv?univ=' + encodeURIComponent('한양대학교(서울)');
  var csv = UrlFetchApp.fetch(url).getContentText('UTF-8').replace(/^﻿/, '');
  var rows = Utilities.parseCsv(csv);
  var sheet = SpreadsheetApp.getActive().getSheetByName('경쟁률');
  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
}
```

---

## 파일 구성

```
server.js              API 서버 (node:http, 의존성 없음)
src/
  fetch.js             HTTP + 한글 인코딩(EUC-KR/UTF-8) 처리
  sources.js           두 사이트의 대학 목록 색인
  parser.js            경쟁률 HTML 파서 (핵심)
  service.js           캐시 + 이름으로 조회
gas/
  경쟁률.gs            Apps Script 단일 파일 (parser.js 와 동일 로직 이식)
test/
  validate.js          전 대학 전수 조회 점검
  gas-smoke.js         .gs 파일을 Apps Script 스텁 위에서 실행 검증
```

## 주의

경쟁률 값은 각 사이트가 10분~1시간 단위로 갱신하며, **마감 직후 최종 수치가 바뀔 수 있다**
(수시 6회 제한 초과자 정리 등). 각 페이지의 `updatedAt`(기준 시각)과 `notice`(대학 공지)를
함께 보여주는 편이 좋다. 개인 참고·모니터링 용도로 쓰고, 짧은 간격의 반복 요청은 피하자.
