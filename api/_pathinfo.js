// 서울시 대중교통 환승경로 API (ws.bus.go.kr pathinfo) → ODsay 경로 모양으로 변환
// ODsay 한도 초과 때만 쓰는 대체 경로. 도보·구간별 소요시간을 안 주므로 거리로 나눠 추정한다.
import { fetchJson, requireEnv, serviceKey } from './_lib.js';
import { busStopsNear } from './_transit.js';

const WALK_M_PER_MIN = 70;
const WALK_DETOUR = 1.3;
// 구간 시간 비율 추정용 평균 속도 (정차 포함)
const BUS_KMH = 15;
const SUBWAY_KMH = 32;
const MAX_PATHS = 5;

function distM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const walkMin = (a, b) => Math.max(1, Math.round((distM(a, b) * WALK_DETOUR) / WALK_M_PER_MIN));

function walk(a, b) {
  return { trafficType: 3, sectionTime: walkMin(a, b), distance: Math.round(distM(a, b) * WALK_DETOUR) };
}

// 버스 정류장 ID(fid) → ARS 번호 (실시간 도착 조회에 필요)
async function arsFor(stationId, pos) {
  const near = await busStopsNear(pos.lat, pos.lng, 80).catch(() => []);
  return near.find((s) => s.stationId === stationId)?.ars ?? null;
}

async function convert(item, from, to) {
  const legs = item.pathList;
  const subPath = [];
  let prev = from;
  const rides = [];
  for (const p of legs) {
    const start = { lat: Number(p.fy), lng: Number(p.fx) };
    const end = { lat: Number(p.ty), lng: Number(p.tx) };
    subPath.push(walk(prev, start));
    const subway = /^\d호선$|선$/.test(p.routeNm) && p.railLinkList;
    const sp = subway
      ? {
          trafficType: 1,
          lane: [{ name: `수도권 ${p.routeNm}`, subwayCode: Number(p.routeNm.match(/^(\d)호선/)?.[1]) || null }],
          // 역 코드가 커지는 쪽을 하행·외선(2)으로 추정
          wayCode: Number(p.tid) > Number(p.fid) ? 2 : 1,
          stationCount: p.railLinkList.length,
        }
      : {
          trafficType: 2,
          lane: [{ busNo: p.routeNm }],
          startArsID: await arsFor(p.fid, start),
        };
    Object.assign(sp, { startName: p.fname, endName: p.tname, startX: p.fx, startY: p.fy, endX: p.tx, endY: p.ty });
    rides.push({ sp, min: (distM(start, end) / 1000 / (subway ? SUBWAY_KMH : BUS_KMH)) * 60 });
    subPath.push(sp);
    prev = end;
  }
  subPath.push(walk(prev, to));
  // 총 시간에서 도보를 뺀 나머지를 구간 거리 비율로 나눔
  const walkTotal = subPath.filter((s) => s.trafficType === 3).reduce((a, s) => a + s.sectionTime, 0);
  const rideBudget = Math.max(rides.length, Number(item.time) - walkTotal);
  const est = rides.reduce((a, r) => a + r.min, 0) || 1;
  for (const r of rides) r.sp.sectionTime = Math.max(1, Math.round((r.min / est) * rideBudget));
  return { subPath, source: 'seoul' };
}

export async function seoulPaths(from, to) {
  const key = serviceKey(requireEnv('SEOUL_BUS_KEY'));
  const qs = new URLSearchParams({ startX: from.lng, startY: from.lat, endX: to.lng, endY: to.lat, resultType: 'json' });
  const data = await fetchJson(`http://ws.bus.go.kr/api/rest/pathinfo/getPathInfoByBusNSub?serviceKey=${key}&${qs}`);
  const items = data.msgBody?.itemList ?? [];
  // 같은 노선 조합은 하나만
  const seen = new Set();
  const picked = items.filter((it) => {
    const sig = it.pathList.map((p) => p.routeNm).join('>');
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  }).slice(0, MAX_PATHS);
  return Promise.all(picked.map((it) => convert(it, from, to)));
}
