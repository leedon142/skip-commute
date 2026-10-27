// ODsay 대중교통 길찾기 (lab.odsay.com)
// 무료 요금제는 하루 30회라, 경로 구조는 오래 저장하고 실시간 부분만 매번 다시 계산한다.
import { requireEnv, HttpError } from './_lib.js';

const BASE = 'https://api.odsay.com/v1/api';
const PATH_TTL_MS = 6 * 60 * 60 * 1000;
const stationCache = new Map();
const pathCache = new Map();

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

// 역 이름 → 좌표 (지하철역 우선). 역 좌표는 바뀌지 않으므로 계속 저장
export async function findStation(name) {
  const clean = name.replace(/역$/, '');
  if (stationCache.has(clean)) return stationCache.get(clean);
  const result = await odsay('searchStation', { stationName: clean, stationClass: '2', CID: '1000' });
  const st = result?.station?.[0];
  if (!st) throw new HttpError(404, `'${name}' 역을 찾지 못했어요`);
  const found = { name: st.stationName, lat: Number(st.y), lng: Number(st.x) };
  stationCache.set(clean, found);
  return found;
}

// 출발 좌표는 약 100m 단위로 묶어서, 같은 건물 근처에서는 저장된 경로를 재사용
export async function searchPaths(from, to) {
  const key = `${from.lat.toFixed(3)},${from.lng.toFixed(3)}>${to.lat},${to.lng}`;
  const hit = pathCache.get(key);
  if (hit && Date.now() - hit.at < PATH_TTL_MS) return hit.paths;
  const result = await odsay('searchPubTransPathT', { SX: from.lng, SY: from.lat, EX: to.lng, EY: to.lat });
  const paths = result?.path ?? [];
  pathCache.set(key, { at: Date.now(), paths });
  return paths;
}
