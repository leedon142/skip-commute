// 서울시 버스·지하철 실시간 API 호출과 응답 정리
import { fetchJson, requireEnv, serviceKey, HttpError } from './_lib.js';

const BUS_BASE = 'http://ws.bus.go.kr/api/rest';
const SUBWAY_BASE = 'http://swopenapi.seoul.go.kr/api/subway';

// 버스 혼잡도 코드 (congestion1/2)
const CONGESTION = { 0: null, 3: '여유', 4: '보통', 5: '혼잡', 6: '매우혼잡' };

async function busApi(path, params) {
  const key = serviceKey(requireEnv('SEOUL_BUS_KEY'));
  const qs = new URLSearchParams({ ...params, resultType: 'json' });
  const data = await fetchJson(`${BUS_BASE}/${path}?serviceKey=${key}&${qs}`);
  const header = data.msgHeader;
  if (header && header.headerCd !== '0' && header.headerCd !== '4') {
    throw new HttpError(502, `버스 API 오류 ${header.headerCd}: ${header.headerMsg}`);
  }
  return data.msgBody?.itemList ?? [];
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
  };
}

export async function busStop(ars) {
  const items = await busApi('stationinfo/getStationByUid', { arsId: ars });
  return {
    ars,
    name: items[0]?.stNm ?? null,
    routes: items.map((it) => ({
      route: it.rtNm,
      routeId: it.busRouteId,
      direction: it.adirection || null,
      nextStop: it.nxtStn || null,
      headwayMin: Number(it.term) || null,
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
  const data = await fetchJson(
    `${SUBWAY_BASE}/${key}/json/realtimeStationArrival/0/30/${encodeURIComponent(name)}`,
  );
  const err = data.errorMessage;
  if (err && err.code !== 'INFO-000') throw new HttpError(502, `지하철 API 오류 ${err.code}: ${err.message}`);
  if (data.code && data.code !== 'INFO-000') throw new HttpError(502, `지하철 API 오류 ${data.code}: ${data.message}`);
  return {
    station: name,
    trains: (data.realtimeArrivalList ?? []).map((t) => ({
      lineId: t.subwayId,
      direction: t.updnLine,
      heading: t.trainLineNm,
      seconds: Number(t.barvlDt) > 0 ? Number(t.barvlDt) : null,
      message: t.arvlMsg2,
      position: t.arvlMsg3,
      express: t.btrainSttus === '급행',
      last: t.lstcarAt === '1',
      receivedAt: t.recptnDt,
    })),
  };
}
