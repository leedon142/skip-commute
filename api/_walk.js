// 도보 시간: OpenStreetMap 보행 경로(routing.openstreetmap.de, 무료·키 없음)로 계산.
// 캠퍼스 안 길·계단까지 지도에 있는 만큼 반영. 실패하면 직선거리 × 우회 계수로 추정.
// 실측 데이터가 생기면 건물·정류장별로 이 값을 덮어쓰면 됨.
import { getCache } from '@vercel/functions';

const BASE = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';
const TTL_SEC = 30 * 24 * 3600;
const cache = process.env.VERCEL ? getCache({ namespace: 'walk' }) : null;
const memory = new Map();

// 약 10m 단위로 묶어서 같은 건물 근처 요청은 재사용
const key = (a, b) => [a.lat, a.lng, b.lat, b.lng].map((n) => n.toFixed(4)).join(',');

async function load(from, to) {
  const res = await fetch(`${BASE}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`, {
    signal: AbortSignal.timeout(3000),
  });
  const route = (await res.json()).routes?.[0];
  if (!route) throw new Error('보행 경로 없음');
  return { sec: Math.round(route.duration), distanceM: Math.round(route.distance) };
}

// 반환: { sec, distanceM, source: 'osm' } 또는 실패 시 null
export async function walkRoute(from, to) {
  const k = key(from, to);
  if (!memory.has(k)) {
    memory.set(k, (async () => {
      const hit = await cache?.get(k).catch(() => undefined);
      if (hit) return hit;
      const value = { ...(await load(from, to)), source: 'osm' };
      await cache?.set(k, value, { ttl: TTL_SEC, name: 'walk' }).catch(() => {});
      return value;
    })().catch(() => {
      memory.delete(k);
      return null;
    }));
  }
  return memory.get(k);
}
