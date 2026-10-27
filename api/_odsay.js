// ODsay 대중교통 길찾기 (lab.odsay.com)
// 무료 요금제는 하루 30회라, 경로 구조는 오래 저장하고 실시간 부분만 매번 다시 계산한다.
// Vercel Runtime Cache에 저장해서 서버 인스턴스가 바뀌어도 유지 (로컬에서는 메모리)
import { getCache } from '@vercel/functions';
import { requireEnv, HttpError } from './_lib.js';

const BASE = 'https://api.odsay.com/v1/api';
const STATION_TTL_SEC = 30 * 24 * 3600;
const PATH_TTL_SEC = 6 * 3600;
const cache = getCache({ namespace: 'odsay' });

async function odsay(path, params) {
  const qs = new URLSearchParams({ ...params, apiKey: requireEnv('ODSAY_KEY') });
  // Vercel은 서버 IP가 고정이 아니라 IP 방식 키를 못 씀 → 웹(URI) 방식 키를 쓰고 등록한 도메인을 Referer로 보냄
  const headers = process.env.ODSAY_REFERER ? { Referer: process.env.ODSAY_REFERER } : {};
  const res = await fetch(`${BASE}/${path}?${qs}`, { headers, signal: AbortSignal.timeout(10_000) });
  const data = await res.json();
  if (data.error) {
    const e = Array.isArray(data.error) ? data.error[0] : data.error;
    throw new HttpError(502, `ODsay 오류 ${e.code}: ${e.message || e.msg}`);
  }
  return data.result;
}

async function cached(key, ttl, load) {
  const hit = await cache.get(key).catch(() => undefined);
  if (hit !== undefined && hit !== null) return hit;
  const value = await load();
  await cache.set(key, value, { ttl, name: key.split(':')[0] }).catch(() => {});
  return value;
}

// 역 이름 → 좌표 (지하철역 우선). 역 좌표는 거의 바뀌지 않으므로 오래 저장
export async function findStation(name) {
  const clean = name.replace(/역$/, '');
  return cached(`station:${clean}`, STATION_TTL_SEC, async () => {
    const result = await odsay('searchStation', { stationName: clean, stationClass: '2', CID: '1000' });
    const st = result?.station?.[0];
    if (!st) throw new HttpError(404, `'${name}' 역을 찾지 못했어요`);
    return { name: st.stationName, lat: Number(st.y), lng: Number(st.x) };
  });
}

// 출발·도착 좌표는 약 100m 단위로 묶어서, 같은 건물 근처에서는 저장된 경로를 재사용
export async function searchPaths(from, to) {
  const r = (n) => n.toFixed(3);
  return cached(`path:${r(from.lat)},${r(from.lng)}>${r(to.lat)},${r(to.lng)}`, PATH_TTL_SEC, async () => {
    const result = await odsay('searchPubTransPathT', { SX: from.lng, SY: from.lat, EX: to.lng, EY: to.lat });
    return result?.path ?? [];
  });
}
