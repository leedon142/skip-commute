// 국민대 셔틀 (학교 공지 시간표) + 학생들의 '탔어요·내렸어요' 기록
// 셔틀은 실시간 위치 데이터가 없어서, 탑승 기록으로 오늘 편이 실제로 다녔는지·몇 분 걸리는지 보여준다
import { createHash } from 'node:crypto';
import { HttpError } from './_lib.js';
import { sharedStore } from './_store.js';
import shuttle from '../data/shuttle.json' with { type: 'json' };

const cache = sharedStore('shuttle');
const KEEP_DAYS = 30;
const STATS_DAYS = 14;
// 출발 예정 시각 기준으로 탑승 기록을 받는 범위 (늦게 오는 차 포함)
const BOARD_BEFORE_MIN = 30;
const BOARD_AFTER_MIN = 20;
const RIDE_MIN = 3;
const RIDE_MAX = 90;

const kst = (ms) => new Date(ms + 9 * 3600e3);
const kstDay = (ms) => kst(ms).toISOString().slice(0, 10);
const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const kstMin = (ms) => { const d = kst(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
// 예정 출발 시각(그날 KST) → epoch ms
const depAt = (day, hm) => Date.parse(`${day}T${hm}:00+09:00`);

export function isServiceDay(ms = Date.now()) {
  const wd = kst(ms).getUTCDay();
  return wd >= 1 && wd <= 5;
}

function findDeparture(line, from, dep) {
  const l = shuttle.lines.find((x) => x.id === line);
  const d = l?.departures.find((x) => x.from === from);
  return d?.times.includes(dep) ? { line: l, dir: d } : null;
}

async function dayList(day) {
  return (await cache.get(`day:${day}`).catch(() => null)) ?? [];
}
async function saveDay(day, list) {
  await cache.set(`day:${day}`, list, { ttl: KEEP_DAYS * 86400, name: 'shuttle-day' });
}

export async function board({ line, from, dep, client }, now = Date.now()) {
  if (!findDeparture(line, from, dep)) throw new HttpError(400, '시간표에 없는 셔틀이에요');
  if (!isServiceDay(now)) throw new HttpError(400, '셔틀은 평일(월~금)에만 다녀요');
  const day = kstDay(now);
  const diff = kstMin(now) - toMin(dep);
  if (diff < -BOARD_BEFORE_MIN || diff > BOARD_AFTER_MIN) {
    throw new HttpError(400, `${dep} 출발편은 출발 ${BOARD_BEFORE_MIN}분 전부터 ${BOARD_AFTER_MIN}분 뒤까지만 기록할 수 있어요`);
  }
  // IP는 저장하지 않고 해시로만 같은 편 중복 기록을 막음
  const who = createHash('sha256').update(`${client}|${day}|${line}|${from}|${dep}`).digest('base64url').slice(0, 16);
  if (await cache.get(`dup:${who}`).catch(() => null)) throw new HttpError(429, '이 셔틀은 이미 탑승을 기록했어요');
  const rec = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, line, from, dep, boardAt: now, alightAt: null };
  await saveDay(day, [...(await dayList(day)), rec]);
  await cache.set(`dup:${who}`, 1, { ttl: 6 * 3600, name: 'shuttle-dup' }).catch(() => {});
  return rec;
}

export async function alight({ id }, now = Date.now()) {
  // 자정 넘어 내리는 경우를 위해 어제 기록도 봄
  for (const day of [kstDay(now), kstDay(now - 86400e3)]) {
    const list = await dayList(day);
    const rec = list.find((r) => r.id === id);
    if (!rec) continue;
    if (rec.alightAt) throw new HttpError(409, '이미 내린 기록이 있어요');
    const rideMin = (now - Math.max(rec.boardAt, depAt(day, rec.dep))) / 60e3;
    if (rideMin < RIDE_MIN || rideMin > RIDE_MAX) throw new HttpError(400, `탑승 후 ${RIDE_MIN}~${RIDE_MAX}분 사이에만 내린 기록을 받아요`);
    rec.alightAt = now;
    await saveDay(day, list);
    return { ...rec, rideMin: Math.round(rideMin) };
  }
  throw new HttpError(404, '탑승 기록을 찾지 못했어요');
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

// 시간표 + 오늘 편별 탑승 기록 + 최근 14일 실제 소요 시간
export async function shuttleStatus(now = Date.now()) {
  const today = kstDay(now);
  const days = Array.from({ length: STATS_DAYS }, (_, i) => kstDay(now - i * 86400e3));
  const lists = await Promise.all(days.map(dayList));
  const todayList = lists[0];
  const trips = {};
  for (const r of todayList) {
    const key = `${r.line}|${r.from}|${r.dep}`;
    const t = (trips[key] ??= { boardings: 0, lastBoardAt: null, alights: 0 });
    t.boardings += 1;
    t.lastBoardAt = Math.max(t.lastBoardAt ?? 0, r.boardAt);
    if (r.alightAt) t.alights += 1;
  }
  // 탄 시각(또는 예정 출발 중 늦은 쪽) → 내린 시각
  const rides = {};
  lists.forEach((list, i) => {
    for (const r of list) {
      if (!r.alightAt) continue;
      const key = `${r.line}|${r.from}`;
      (rides[key] ??= []).push((r.alightAt - Math.max(r.boardAt, depAt(days[i], r.dep))) / 60e3);
    }
  });
  const ride = Object.fromEntries(Object.entries(rides).map(([k, xs]) => [k, { medianMin: Math.round(median(xs)), n: xs.length, days: STATS_DAYS }]));
  return { ...shuttle, today, serviceDay: isServiceDay(now), trips, ride, boardWindow: { beforeMin: BOARD_BEFORE_MIN, afterMin: BOARD_AFTER_MIN } };
}
