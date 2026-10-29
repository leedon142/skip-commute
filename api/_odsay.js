// ODsay 대중교통 길찾기 (lab.odsay.com)
// 무료 요금제는 하루 30회라, 경로 구조는 오래 저장하고 실시간 부분만 매번 다시 계산한다.
// 배포: Vercel Runtime Cache, 로컬 개발: data/.odsay-cache.json 파일 (재시작해도 유지)
// 호출이 실패하면(한도 초과 등) 기간이 지난 저장 경로 → 서울시 환승경로 API 순서로 대신 씀
import { getCache } from '@vercel/functions';
import { readFileSync, writeFileSync } from 'node:fs';
import { requireEnv, HttpError } from './_lib.js';
import { seoulPaths } from './_pathinfo.js';

const BASE = 'https://api.odsay.com/v1/api';
const STATION_TTL_SEC = 30 * 24 * 3600;
// 노선 구조는 자주 안 바뀌므로 7일. 실시간 도착·혼잡도는 매번 새로 계산
const PATH_TTL_SEC = 7 * 24 * 3600;
// 한도 초과 대비 예비 사본. 노선이 조금 바뀌었어도 실시간 계산은 매번 새로 하므로 안 주는 것보다 나음
const STALE_TTL_SEC = 90 * 24 * 3600;
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

// 유료(건당 25원) 키 보호용 하루 호출 상한. 넘으면 한도 초과와 똑같이 저장본·서울시 경로로 넘어감
// ODSAY_DAILY_LIMIT로 조절, 기본은 배포 100회(최대 하루 2,500원) / 로컬 30회
const DAILY_LIMIT = Number(process.env.ODSAY_DAILY_LIMIT) || (process.env.VERCEL ? 100 : 30);

// 날짜별 호출 수 (KST). 동시 요청이 겹치면 몇 회 정도 오차가 날 수 있음
const kstDay = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

// 날짜별 호출 수는 평균을 보려고 90일 보관
const COUNT_KEEP_DAYS = 90;

async function countCall() {
  const key = `count:${kstDay(Date.now())}`;
  const used = Number(await cache.get(key).catch(() => 0)) || 0;
  if (used >= DAILY_LIMIT) {
    throw new HttpError(429, `오늘 길찾기 호출 상한(${DAILY_LIMIT}회)에 도달했어요. 저장된 경로나 서울시 경로로 대신 찾아요.`);
  }
  await cache.set(key, used + 1, { ttl: COUNT_KEEP_DAYS * 24 * 3600, name: 'count' }).catch(() => {});
}

// 최근 n일 날짜별 호출 수 (오늘부터 거꾸로)
export async function odsayUsage(days = 30) {
  const n = Math.min(Math.max(1, days), COUNT_KEEP_DAYS);
  const list = await Promise.all(Array.from({ length: n }, async (_, i) => {
    const day = kstDay(Date.now() - i * 24 * 3600_000);
    return { day, calls: Number(await cache.get(`count:${day}`).catch(() => 0)) || 0 };
  }));
  const used = list.filter((d) => d.calls > 0);
  const total = list.reduce((a, d) => a + d.calls, 0);
  return {
    limit: DAILY_LIMIT,
    today: list[0].calls,
    total,
    costWon: total * 25,
    // 호출이 있었던 날 기준 평균 (상한 정할 때 참고)
    avgPerActiveDay: used.length ? Math.round(total / used.length) : 0,
    maxDay: used.reduce((m, d) => Math.max(m, d.calls), 0),
    days: list,
  };
}

async function odsay(path, params) {
  await countCall();
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

// 저장 형식 { at, value } (예전 형식은 값만 저장돼 있어서 at 없음)
const unwrap = (hit) => (hit && typeof hit === 'object' && 'value' in hit && 'at' in hit ? hit : { at: null, value: hit });

// 같은 키를 동시에 여러 요청이 찾으면 ODsay는 한 번만 부름
const inflight = new Map();

async function cachedEntry(key, ttl, load) {
  const hit = await cache.get(key).catch(() => undefined);
  if (hit !== undefined && hit !== null) return { ...unwrap(hit), cached: true };
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const entry = { at: Date.now(), value: await load() };
      const name = key.split(':')[0];
      await cache.set(key, entry, { ttl, name }).catch(() => {});
      await cache.set(`stale:${key}`, entry, { ttl: STALE_TTL_SEC, name: 'stale' }).catch(() => {});
      return { ...entry, cached: false };
    })().finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

async function cached(key, ttl, load) {
  return (await cachedEntry(key, ttl, load)).value;
}

// 기간 지난 예비 사본
async function staleEntry(key) {
  const hit = await cache.get(`stale:${key}`).catch(() => undefined);
  return hit ? unwrap(hit) : null;
}

// 역 이름 → 좌표 (지하철역 우선). 역 좌표는 거의 바뀌지 않으므로 오래 저장
export async function findStation(name) {
  const clean = name.replace(/역$/, '');
  const key = `station:${clean}`;
  try {
    return await cached(key, STATION_TTL_SEC, async () => {
      const result = await odsay('searchStation', { stationName: clean, stationClass: '2', CID: '1000' });
      const st = result?.station?.[0];
      if (!st) throw new HttpError(404, `'${name}' 역을 찾지 못했어요`);
      return { name: st.stationName, lat: Number(st.y), lng: Number(st.x) };
    });
  } catch (e) {
    const stale = e.status === 404 ? null : await staleEntry(key);
    if (stale) return stale.value;
    throw e;
  }
}

export function pathKey(from, to) {
  const r = (n) => n.toFixed(3);
  return `path:${r(from.lat)},${r(from.lng)}>${r(to.lat)},${r(to.lng)}`;
}

// 출발·도착 좌표는 약 100m 단위로 묶어서, 같은 건물 근처에서는 저장된 경로를 재사용
// 반환: { paths, source: 'odsay'|'odsay-stale'|'seoul', at(경로를 받아온 시각), cached }
export async function searchPaths(from, to) {
  const key = pathKey(from, to);
  try {
    const e = await cachedEntry(key, PATH_TTL_SEC, async () => {
      const result = await odsay('searchPubTransPathT', { SX: from.lng, SY: from.lat, EX: to.lng, EY: to.lat });
      return result?.path ?? [];
    });
    return { paths: e.value, source: 'odsay', at: e.at, cached: e.cached };
  } catch (err) {
    const stale = await staleEntry(key);
    if (stale?.value?.length) return { paths: stale.value, source: 'odsay-stale', at: stale.at, cached: true, error: err.message };
    try {
      const paths = await seoulPaths(from, to);
      if (paths.length) return { paths, source: 'seoul', at: Date.now(), cached: false, error: err.message };
    } catch {}
    throw err;
  }
}
