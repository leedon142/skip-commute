// 정류장 줄 제보 (학생들이 누른 여유·보통·혼잡) — 모든 사용자가 같이 봄
// 제보는 짧게만 의미가 있어서 2시간 지나면 버림. 동시에 여러 명이 누르면 드물게 한 건이 빠질 수 있음
import { createHash } from 'node:crypto';
import { HttpError } from './_lib.js';
import { sharedStore } from './_store.js';

const KEEP_MS = 2 * 3600e3;
const MAX_REPORTS = 300;
// 같은 사람(IP)이 같은 정류장에 다시 제보할 수 있는 간격 (앱의 쿨타임과 같음)
const COOLDOWN_SEC = 5 * 60;
// 추천에 반영하는 범위: 15분 안의 제보, 탑승이 20분 안일 때만 (줄 상황은 금방 바뀜)
export const REPORT_FRESH_MS = 15 * 60e3;
export const REPORT_APPLY_SEC = 20 * 60;
export const LEVELS = { ok: '여유', mid: '보통', busy: '혼잡' };
// 날씨 제보 (kind: 'weather'): 지금 그 자리에서 보이는 날씨. 화면에 보여주기만 하고 추천 계산에는 안 씀
export const WEATHER_VALUES = { clear: '안 와요', rain: '비 와요', snow: '눈 와요' };
const WEATHER_RADIUS_M = 2000; // 이 안에서 들어온 날씨 제보를 같은 날씨로 봄

const cache = sharedStore('reports');

export async function listReports(now = Date.now()) {
  const all = (await cache.get('list').catch(() => null)) ?? [];
  return all.filter((r) => now - r.at < KEEP_MS);
}

const isCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

// 줄 상황 제보: { ars, name, level }  ·  날씨 제보: { kind: 'weather', ars, name, value, lat, lng }
export async function addReport({ ars, name, level, kind, value, lat, lng, client }, now = Date.now()) {
  const weather = kind === 'weather';
  if (!/^\d{5}$/.test(String(ars))) throw new HttpError(400, '정류장 번호(5자리)가 필요해요');
  if (weather ? !WEATHER_VALUES[value] : !LEVELS[level]) {
    throw new HttpError(400, weather ? 'value는 clear, rain, snow 중 하나예요' : 'level은 ok, mid, busy 중 하나예요');
  }
  if (weather && !isCoord(Number(lat), Number(lng))) throw new HttpError(400, '날씨 제보는 위치(lat, lng)가 필요해요');
  // IP는 저장하지 않고 해시로만 쿨타임 확인 (줄 제보와 날씨 제보는 따로 셈)
  const who = createHash('sha256').update(`${client}|${ars}${weather ? '|weather' : ''}`).digest('base64url').slice(0, 16);
  if (await cache.get(`cool:${who}`).catch(() => null)) {
    throw new HttpError(429, `같은 정류장은 ${COOLDOWN_SEC / 60}분에 한 번만 제보할 수 있어요`);
  }
  const base = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, ars: String(ars), name: String(name || ars).slice(0, 30), at: now };
  const report = weather ? { ...base, kind, value, lat: Number(lat), lng: Number(lng) } : { ...base, level };
  const list = [report, ...(await listReports(now))].slice(0, MAX_REPORTS);
  await cache.set('list', list, { ttl: KEEP_MS / 1000, name: 'reports' });
  await cache.set(`cool:${who}`, 1, { ttl: COOLDOWN_SEC, name: 'report-cooldown' }).catch(() => {});
  return report;
}

// 한 정류장의 최근 제보 요약 → { level, count, total, agoMin } 또는 null
// 가장 많이 나온 상태 (같으면 최근 것)
export function summarize(reports, ars, now = Date.now()) {
  const fresh = reports.filter((r) => r.kind !== 'weather' && r.ars === ars && now - r.at < REPORT_FRESH_MS);
  if (!fresh.length) return null;
  const counts = {};
  for (const r of fresh) counts[r.level] = (counts[r.level] ?? 0) + 1;
  const level = fresh.reduce((best, r) => (counts[r.level] > counts[best] ? r.level : best), fresh[0].level);
  const latest = fresh.find((r) => r.level === level);
  return { level, label: LEVELS[level], count: counts[level], total: fresh.length, agoMin: Math.round((now - latest.at) / 60000) };
}

function distM(a, b) {
  const D = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * D) / 2) ** 2 + Math.cos(a.lat * D) * Math.cos(b.lat * D) * Math.sin(((b.lng - a.lng) * D) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// pos 근처(2km)에서 15분 안에 들어온 날씨 제보 요약 → { value, label, count, total, agoMin } 또는 null
// 가장 많이 나온 날씨 (같으면 최근 것)
export function summarizeWeather(reports, pos, now = Date.now()) {
  const fresh = reports.filter((r) => r.kind === 'weather' && now - r.at < REPORT_FRESH_MS && distM(pos, r) <= WEATHER_RADIUS_M);
  if (!fresh.length) return null;
  const counts = {};
  for (const r of fresh) counts[r.value] = (counts[r.value] ?? 0) + 1;
  const value = fresh.reduce((best, r) => (counts[r.value] > counts[best] ? r.value : best), fresh[0].value);
  const latest = fresh.find((r) => r.value === value);
  return { value, label: WEATHER_VALUES[value], count: counts[value], total: fresh.length, agoMin: Math.round((now - latest.at) / 60000) };
}

// 상황 제보 (kind: 'situation'): 학우가 쓰거나 말한 사고·정체·통제·날씨를 AI(Gemini)가 정리한 것. 정류장이 아니라 제보한 자리 기준
// 화면(사고·통제 카드)과 AI 경로 선택에만 쓰고, 엔진의 소요시간 계산에는 안 씀
export const SITUATION_FRESH_MS = 30 * 60e3;
const SITUATION_RADIUS_M = 2000;
const SITUATION_COOLDOWN_SEC = 2 * 60;

export async function addSituation({ type, affects, summary, lat, lng, client }, now = Date.now()) {
  if (!isCoord(Number(lat), Number(lng))) throw new HttpError(400, '상황 제보는 위치(lat, lng)가 필요해요');
  const report = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: 'situation', type, affects, summary, lat: Number(lat), lng: Number(lng), at: now };
  const list = [report, ...(await listReports(now))].slice(0, MAX_REPORTS);
  await cache.set('list', list, { ttl: KEEP_MS / 1000, name: 'reports' });
  await cache.set(`cool:${situationWho(client)}`, 1, { ttl: SITUATION_COOLDOWN_SEC, name: 'report-cooldown' }).catch(() => {});
  return report;
}

// AI를 부르기 전에 확인 (쿨타임 중이면 AI 호출도 안 함)
export async function checkSituationCooldown(client) {
  if (await cache.get(`cool:${situationWho(client)}`).catch(() => null)) {
    throw new HttpError(429, `상황 제보는 ${SITUATION_COOLDOWN_SEC / 60}분에 한 번만 할 수 있어요`);
  }
}
const situationWho = (client) => createHash('sha256').update(`${client}|situation`).digest('base64url').slice(0, 16);

// pos 근처(2km)에서 30분 안의 상황 제보 (최신순)
export function situationsNear(reports, pos, now = Date.now(), limit = 10) {
  return reports
    .filter((r) => r.kind === 'situation' && now - r.at < SITUATION_FRESH_MS && distM(pos, r) <= SITUATION_RADIUS_M)
    .slice(0, limit)
    .map((r) => ({ id: r.id, type: r.type, affects: r.affects, summary: r.summary, at: r.at, agoMin: Math.round((now - r.at) / 60000), distM: Math.round(distM(pos, r)) }));
}

// pos 근처(2km)에서 최근 2시간 날씨 제보 목록 (최신순) → 현장 피드용
export function weatherFeed(reports, pos, now = Date.now(), limit = 30) {
  return reports
    .filter((r) => r.kind === 'weather' && now - r.at < KEEP_MS && distM(pos, r) <= WEATHER_RADIUS_M)
    .slice(0, limit)
    .map((r) => ({ id: r.id, name: r.name, value: r.value, label: WEATHER_VALUES[r.value], at: r.at }));
}
