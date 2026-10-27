// ODsay 대중교통 길찾기 (lab.odsay.com)
// 무료 요금제는 하루 30회라, 경로 구조는 오래 저장하고 실시간 부분만 매번 다시 계산한다.
// 배포: Vercel Runtime Cache, 로컬 개발: data/.odsay-cache.json 파일 (재시작해도 유지)
import { getCache } from '@vercel/functions';
import { readFileSync, writeFileSync } from 'node:fs';
import { requireEnv, HttpError } from './_lib.js';

const BASE = 'https://api.odsay.com/v1/api';
const STATION_TTL_SEC = 30 * 24 * 3600;
const PATH_TTL_SEC = process.env.VERCEL ? 6 * 3600 : 7 * 24 * 3600;
const LOCAL_FILE = process.env.VERCEL ? null : new URL('../data/.odsay-cache.json', import.meta.url);
const cache = LOCAL_FILE ? fileCache(LOCAL_FILE) : getCache({ namespace: 'odsay' });

function fileCache(file) {
  let store = {};
  try { store = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  return {
    async get(key) {
      const e = store[key];
      return e && Date.now() < e.exp ? e.value : undefined;
    },
    async set(key, value, { ttl }) {
      store[key] = { exp: Date.now() + ttl * 1000, value };
      writeFileSync(file, JSON.stringify(store));
    },
  };
}

async function odsay(path, params) {
  const qs = new URLSearchParams({ ...params, apiKey: requireEnv('ODSAY_KEY') });
  // Vercel은 서버 IP가 고정이 아니라 IP 방식 키를 못 씀 → 웹(URI) 방식 키를 쓰고 등록한 도메인을 Referer로 보냄
  const headers = process.env.ODSAY_REFERER ? { Referer: process.env.ODSAY_REFERER } : {};
  const res = await fetch(`${BASE}/${path}?${qs}`, { headers, signal: AbortSignal.timeout(10_000) });
  const data = await res.json();
  if (data.error) {
    const e = Array.isArray(data.error) ? data.error[0] : data.error;
    const quota = String(e.code) === '429';
    throw new HttpError(quota ? 429 : 502, quota
      ? '오늘 길찾기(ODsay) 무료 호출 한도를 다 썼어요. 내일 다시 시도하거나, 이미 계산해 둔 출발 위치(정문)로 조회해 주세요.'
      : `ODsay 오류 ${e.code}: ${e.message || e.msg}`);
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

export function pathKey(from, to) {
  const r = (n) => n.toFixed(3);
  return `path:${r(from.lat)},${r(from.lng)}>${r(to.lat)},${r(to.lng)}`;
}

// 출발·도착 좌표는 약 100m 단위로 묶어서, 같은 건물 근처에서는 저장된 경로를 재사용
export async function searchPaths(from, to) {
  return cached(pathKey(from, to), PATH_TTL_SEC, async () => {
    const result = await odsay('searchPubTransPathT', { SX: from.lng, SY: from.lat, EX: to.lng, EY: to.lat });
    return result?.path ?? [];
  });
}
