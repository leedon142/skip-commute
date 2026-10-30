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

const cache = sharedStore('reports');

export async function listReports(now = Date.now()) {
  const all = (await cache.get('list').catch(() => null)) ?? [];
  return all.filter((r) => now - r.at < KEEP_MS);
}

export async function addReport({ ars, name, level, client }, now = Date.now()) {
  if (!/^\d{5}$/.test(String(ars))) throw new HttpError(400, '정류장 번호(5자리)가 필요해요');
  if (!LEVELS[level]) throw new HttpError(400, 'level은 ok, mid, busy 중 하나예요');
  // IP는 저장하지 않고 해시로만 쿨타임 확인
  const who = createHash('sha256').update(`${client}|${ars}`).digest('base64url').slice(0, 16);
  if (await cache.get(`cool:${who}`).catch(() => null)) {
    throw new HttpError(429, `같은 정류장은 ${COOLDOWN_SEC / 60}분에 한 번만 제보할 수 있어요`);
  }
  const report = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, ars: String(ars), name: String(name || ars).slice(0, 30), level, at: now };
  const list = [report, ...(await listReports(now))].slice(0, MAX_REPORTS);
  await cache.set('list', list, { ttl: KEEP_MS / 1000, name: 'reports' });
  await cache.set(`cool:${who}`, 1, { ttl: COOLDOWN_SEC, name: 'report-cooldown' }).catch(() => {});
  return report;
}

// 한 정류장의 최근 제보 요약 → { level, count, total, agoMin } 또는 null
// 가장 많이 나온 상태 (같으면 최근 것)
export function summarize(reports, ars, now = Date.now()) {
  const fresh = reports.filter((r) => r.ars === ars && now - r.at < REPORT_FRESH_MS);
  if (!fresh.length) return null;
  const counts = {};
  for (const r of fresh) counts[r.level] = (counts[r.level] ?? 0) + 1;
  const level = fresh.reduce((best, r) => (counts[r.level] > counts[best] ? r.level : best), fresh[0].level);
  const latest = fresh.find((r) => r.level === level);
  return { level, label: LEVELS[level], count: counts[level], total: fresh.length, agoMin: Math.round((now - latest.at) / 60000) };
}
