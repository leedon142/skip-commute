// 서울시 버스·지하철 실시간 API 호출과 응답 정리
import { getCache } from '@vercel/functions';
import { fetchJsonAt, forgetCached, requireEnv, serviceKey, HttpError } from './_lib.js';

const BUS_BASE = 'http://ws.bus.go.kr/api/rest';
const SUBWAY_BASE = 'http://swopenapi.seoul.go.kr/api/subway';

// 버스 혼잡도 코드 (congestion1/2)
const CONGESTION = { 0: null, 3: '여유', 4: '보통', 5: '혼잡', 6: '매우혼잡' };

async function busApi(path, params, withTime = false) {
  const key = serviceKey(requireEnv('SEOUL_BUS_KEY'));
  const qs = new URLSearchParams({ ...params, resultType: 'json' });
  const url = `${BUS_BASE}/${path}?serviceKey=${key}&${qs}`;
  let { data, at } = await fetchJsonAt(url);
  // 요청이 몰리면(초당 한도) 401 + '요청제한 횟수 초과'가 옴 → 잠깐 뒤 한 번만 다시
  if (isLimited(data)) {
    forgetCached(url);
    await new Promise((r) => setTimeout(r, 800));
    ({ data, at } = await fetchJsonAt(url));
  }
  // 키 오류·한도 초과는 msgHeader 없이 { error, message }로 옴 → '운행 정보 없음'으로 보이지 않게 오류로
  if (data.error || !data.msgHeader) {
    forgetCached(url);
    const msg = String(data.message || data.error || '알 수 없는 응답');
    throw new HttpError(isLimited(data) ? 429 : 502, isLimited(data)
      ? '서울시 버스 API 호출 한도에 걸렸어요. 잠시 뒤 새로고침해 주세요.'
      : `버스 API 오류: ${msg.slice(0, 100)}`);
  }
  const header = data.msgHeader;
  if (header && header.headerCd !== '0' && header.headerCd !== '4') {
    throw new HttpError(502, `버스 API 오류 ${header.headerCd}: ${header.headerMsg}`);
  }
  const items = data.msgBody?.itemList ?? [];
  return withTime ? { items, at } : items;
}

function isLimited(data) {
  return /횟수 초과/.test(String(data?.message || ''));
}

// "3분12초후[2번째 전]" → 192초
function parseArrMsg(msg) {
  if (!msg) return null;
  if (msg.includes('곧 도착')) return 0;
  const m = msg.match(/(?:(\d+)분)?\s*(?:(\d+)초)?후/);
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] || 0) * 60 + Number(m[2] || 0);
}

function busArrival(it, n) {
  const msg = it[`arrmsg${n}`];
  const parsed = parseArrMsg(msg);
  const traTime = Number(it[`traTime${n}`]);
  const riders = it[`rerideNum${n}`];
  return {
    // traTime은 초 단위 예측값. 운행종료·출발대기면 메시지에서 null이 나오므로 그대로 둠
    seconds: parsed == null ? null : traTime > 0 ? traTime : parsed,
    message: msg,
    congestion: CONGESTION[Number(it[`congestion${n}`])] ?? null,
    passengers: riders != null && riders !== '' ? Number(riders) : null,
    full: it[`isFullFlag${n}`] === '1',
    last: it[`isLast${n}`] === '1',
    stopsAway: Number(msg?.match(/\[(\d+)번째 전\]/)?.[1]) || null,
    // 같은 차를 다른 정류장에서 찾을 때 씀 (탑승 → 하차 실시간 소요)
    vehId: it[`vehId${n}`] || null,
  };
}

export async function busStop(ars) {
  const { items, at } = await busApi('stationinfo/getStationByUid', { arsId: ars }, true);
  return {
    ars,
    fetchedAt: new Date(at).toISOString(),
    name: items[0]?.stNm ?? null,
    routes: items.map((it) => ({
      route: it.rtNm,
      routeId: it.busRouteId,
      direction: it.adirection || null,
      nextStop: it.nxtStn || null,
      headwayMin: Number(it.term) || null,
      // 기점(차고지) 첫차·막차 출발 시각 'HHmm'. 이 정류장을 지나는 시각은 이보다 늦음
      firstTm: it.firstTm?.trim() || null,
      lastTm: it.lastTm?.trim() || null,
      arrivals: [busArrival(it, 1), busArrival(it, 2)],
    })),
  };
}

export async function busStopsNear(lat, lng, radius) {
  const items = await busApi('stationinfo/getStationByPos', { tmX: lng, tmY: lat, radius });
  return items.map((it) => ({
    name: it.stationNm,
    ars: it.arsId,
    stationId: it.stationId,
    lat: Number(it.gpsY),
    lng: Number(it.gpsX),
    distM: Number(it.dist),
  }));
}

export async function subwayStation(name) {
  const key = requireEnv('SEOUL_SUBWAY_KEY');
  const { data, at } = await fetchJsonAt(
    `${SUBWAY_BASE}/${key}/json/realtimeStationArrival/0/30/${encodeURIComponent(name)}`,
  );
  const err = data.errorMessage;
  if (err && err.code !== 'INFO-000') throw new HttpError(502, `지하철 API 오류 ${err.code}: ${err.message}`);
  if (data.code && data.code !== 'INFO-000') throw new HttpError(502, `지하철 API 오류 ${data.code}: ${data.message}`);
  return {
    station: name,
    fetchedAt: new Date(at).toISOString(),
    trains: (data.realtimeArrivalList ?? []).map((t) => ({
      lineId: t.subwayId,
      direction: t.updnLine,
      heading: t.trainLineNm,
      // 열차 번호: 길안내에서 탄 열차가 내릴 역에 언제 오는지 추적
      trainNo: t.btrainNo || null,
      seconds: Number(t.barvlDt) > 0 ? Number(t.barvlDt) : null,
      message: t.arvlMsg2,
      position: t.arvlMsg3,
      express: t.btrainSttus === '급행',
      last: t.lstcarAt === '1',
      receivedAt: t.recptnDt,
    })),
  };
}

// ---------------- 지하철 시간표 (서울 열린데이터광장, 1~8호선) ----------------
// 실시간 범위 밖(수업 끝나는 시각 등)일 때 실제 열차 시각으로 대기 시간을 계산. 우이신설 등은 데이터 없음
const OPEN_BASE = 'http://openapi.seoul.go.kr:8088';
const TIMETABLE_TTL_SEC = 7 * 24 * 3600;
const ttCache = process.env.VERCEL ? getCache({ namespace: 'subway-tt' }) : null;
const ttMemory = new Map();

async function openApi(service, ...args) {
  const key = requireEnv('SEOUL_OPENDATA_KEY');
  const { data } = await fetchJsonAt(`${OPEN_BASE}/${key}/json/${service}/1/500/${args.map(encodeURIComponent).join('/')}/`);
  const body = data[service];
  if (!body) {
    if (data.RESULT?.CODE === 'INFO-200') return [];
    throw new HttpError(502, `시간표 API 오류 ${data.RESULT?.CODE}: ${data.RESULT?.MESSAGE}`);
  }
  return body.row ?? [];
}

function memo(key, load) {
  if (!ttMemory.has(key)) {
    ttMemory.set(key, (async () => {
      const hit = await ttCache?.get(key).catch(() => undefined);
      if (hit) return hit;
      const value = await load();
      await ttCache?.set(key, value, { ttl: TIMETABLE_TTL_SEC, name: 'subway-tt' }).catch(() => {});
      return value;
    })().catch((e) => {
      ttMemory.delete(key);
      throw e;
    }));
  }
  return ttMemory.get(key);
}

// lineNo: 1~8 (숫자), inout: 1 상행·내선 / 2 하행·외선, week: 1 평일 / 2 토 / 3 휴일
// 반환: 출발 시각(자정 기준 초, 24시 넘으면 그대로 86400+) 오름차순 [{ sec, heading, express }]
export async function subwayTimetable(station, lineNo, inout, week) {
  const name = station.replace(/역$/, '');
  return memo(`tt:${name}:${lineNo}:${inout}:${week}`, async () => {
    const info = await openApi('SearchInfoBySubwayNameService', name);
    const st = info.find((r) => Number(r.LINE_NUM.match(/^0?(\d)호선/)?.[1]) === lineNo);
    if (!st) return [];
    const rows = await openApi('SearchSTNTimeTableByIDService', st.STATION_CD, week, inout);
    return rows
      .map((r) => {
        const [h, m, sec] = (r.LEFTTIME !== '00:00:00' ? r.LEFTTIME : r.ARRIVETIME).split(':').map(Number);
        return { sec: h * 3600 + m * 60 + sec, heading: r.SUBWAYENAME, express: r.EXPRESS_YN === 'D' };
      })
      .filter((t) => Number.isFinite(t.sec))
      .sort((a, b) => a.sec - b.sec);
  });
}
