// 하교 경로 추천 엔진
// ODsay로 경로 후보를 받고, 각 구간을 서울시 실시간 도착·탑승 인원과 승하차 통계로 다시 계산한다.
import { busStop, busStopsNear, subwayStation } from './_transit.js';
import { findStation, searchPaths } from './_odsay.js';
import profile from '../data/boarding_profile.json' with { type: 'json' };
import subwayStats from '../data/subway_congestion.json' with { type: 'json' };

// 정문 국민대앞(08107) 좌표. GPS가 없을 때 출발지로 사용
export const MAIN_GATE = { lat: 37.6106795513, lng: 126.9940273315 };
// 국민대후문(08392) 좌표. 캠퍼스 출발 경로의 두 번째 기준점
const BACK_GATE = { lat: 37.6111973107, lng: 126.9994533062 };
const CAMPUS_RADIUS_M = 1000;

const BOARD_BUFFER_SEC = 30; // 정류장 도착 후 탑승까지 여유
const WALK_M_PER_MIN = 70; // 직선거리 기반 도보 추정 속도
const WALK_DETOUR = 1.3; // 직선거리 → 실제 보행거리 보정
const MAX_UPSTREAM_WALK_M = 700; // 이전 정류장으로 걸어갈 최대 직선거리
// 일반 시내버스 기준 가정값. 실제 차량별 좌석 수는 API에서 주지 않음
const BUS_SEATS = 25;
const BUS_CAPACITY = 60;
const MISS_PROB = { 여유: 0, 보통: 0.1, 혼잡: 0.4, 매우혼잡: 0.7 };

// ODsay 노선 이름 → 서울 실시간 지하철 API subwayId
const SUBWAY_IDS = { 우이신설: '1092', 경의중앙: '1063', 공항: '1065', 경춘: '1067', 수인분당: '1075', 신분당: '1077', 서해: '1093', 신림: '1094' };

function subwayIdFor(lane) {
  const code = Number(lane?.subwayCode);
  if (code >= 1 && code <= 9) return `100${code}`;
  const hit = Object.keys(SUBWAY_IDS).find((k) => lane?.name?.includes(k));
  return hit ? SUBWAY_IDS[hit] : null;
}

function kstHour(date) {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Seoul' }).format(date));
}

function weekdaysInMonth(ym) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4)) - 1;
  let n = 0;
  for (let d = new Date(Date.UTC(y, m, 1)); d.getUTCMonth() === m; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() % 6 !== 0) n++;
  }
  return n;
}
const WEEKDAYS = weekdaysInMonth(profile.month);

function distM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function walkSecFromDist(m) {
  return Math.round((m * WALK_DETOUR) / WALK_M_PER_MIN * 60);
}

// 통계 프로필에서 노선·정류장 위치 찾기
function routeStops(busNo) {
  const key = Object.keys(profile.routes).find((r) => busNo === r || busNo?.startsWith(r));
  return key ? profile.routes[key] : null;
}

function stopStats(busNo, ars) {
  const stops = routeStops(busNo);
  if (!stops) return null;
  const i = stops.findIndex((s) => s.ars === ars);
  if (i < 0) return null;
  const prev = stops[i - 1];
  // 직전 정류장에서 거의 아무도 안 타고 다 내리면 그곳이 회차 지점 → 여기서 새로 출발
  const startsHere = i === 0 || (prev && sum(prev.on) < sum(prev.off) * 0.05);
  return { stops, i, stop: stops[i], prev, startsHere };
}

const sum = (a) => a.reduce((x, y) => x + y, 0);

function matchRoute(stopData, busNo) {
  return stopData.routes.find((r) => r.route === busNo)
    ?? stopData.routes.find((r) => r.route.startsWith(busNo) || busNo.startsWith(r.route));
}

// 내가 정류장에 도착하는 시점(atSec) 이후 첫 차
// ODsay 구간의 정차 정류장·역 이름 (탑승지 포함, 하차지 포함)
function stopNames(sp) {
  return (sp.passStopList?.stations ?? []).map((s) => s.stationName);
}

async function busLeg(sp, atSec, now, arsOverride) {
  const busNo = sp.lane?.[0]?.busNo;
  const ars = arsOverride ?? sp.startArsID?.replace('-', '');
  const leg = {
    type: 'bus', route: busNo, busType: sp.lane?.[0]?.type ?? null, from: sp.startName, to: sp.endName, ars,
    rideMin: sp.sectionTime, stations: sp.stationCount, stops: stopNames(sp),
    realtime: false, waitSec: null, congestion: null, passengers: null, full: false, notes: [],
  };

  let route = null;
  if (ars) {
    try {
      const stopData = await busStop(ars);
      leg.from = stopData.name ?? leg.from;
      route = matchRoute(stopData, busNo);
    } catch (e) {
      leg.notes.push(`실시간 조회 실패: ${e.message}`);
    }
  }
  const headwaySec = ((route?.headwayMin || Number(sp.intervalTime)) || 10) * 60;

  const catchable = route?.arrivals.find((a) => a.seconds != null && a.seconds >= atSec + BOARD_BUFFER_SEC);
  if (catchable) {
    leg.realtime = true;
    leg.waitSec = catchable.seconds - atSec;
    leg.congestion = catchable.congestion;
    leg.passengers = catchable.passengers;
    leg.full = catchable.full;
    leg.stopsAway = catchable.stopsAway;
    // 이 차를 놓치면 탈 다음 차
    const after = route.arrivals.find((a) => a !== catchable && a.seconds != null && a.seconds > catchable.seconds);
    if (after) leg.nextVehicle = { waitSec: after.seconds - atSec, passengers: after.passengers, congestion: after.congestion, stopsAway: after.stopsAway };
  } else {
    // 보이는 마지막 차를 놓쳤으면 그 차 + 배차간격, 운행 중인 차가 안 보이면 배차간격의 절반
    const lastSeen = Math.max(-1, ...(route?.arrivals ?? []).map((a) => a.seconds ?? -1));
    if (lastSeen >= 0 && atSec - lastSeen < headwaySec) {
      leg.waitSec = Math.max(lastSeen + headwaySec - atSec, BOARD_BUFFER_SEC);
      leg.notes.push('실시간으로 보이는 차는 놓침 · 그다음 차 추정');
    } else if (lastSeen >= 0) {
      // 정류장 도착이 실시간으로 보이는 범위보다 한참 뒤 (예: 내일 아침)
      leg.waitSec = Math.round(headwaySec / 2);
      leg.notes.push('실시간 범위 밖 · 배차간격으로 추정');
    } else {
      leg.waitSec = Math.round(headwaySec / 2);
      const msg = route?.arrivals[0]?.message;
      leg.notes.push(msg ? `${msg.trim()} · 배차간격으로 추정` : '실시간 정보 없음 · 배차간격으로 추정');
    }
  }

  // 평소 이 시간대에 이 정류장에서 한 대당 타는 인원 (통계)
  const stats = ars && stopStats(busNo, ars);
  const hour = kstHour(new Date(now + (atSec + leg.waitSec) * 1000));
  let boardersPerBus = null;
  if (stats) {
    const busesPerHour = 3600 / headwaySec;
    boardersPerBus = Math.round(stats.stop.on[hour] / WEEKDAYS / busesPerHour);
    leg.startsHere = stats.startsHere;
    leg.typicalBoarders = boardersPerBus;
  }

  // 못 탈 확률 → 기대 추가 대기
  let miss = leg.full ? 0.9 : MISS_PROB[leg.congestion] ?? 0;
  if (leg.passengers != null && boardersPerBus != null && leg.passengers + boardersPerBus > BUS_CAPACITY) {
    miss = Math.max(miss, 0.5);
    leg.notes.push(`평소 이 시간 한 대당 ${boardersPerBus}명 탑승 · 만차 위험`);
  }
  leg.missProb = miss;
  leg.extraWaitSec = Math.round(miss * headwaySec);

  if (leg.passengers != null) {
    const ahead = leg.startsHere ? 0 : Math.min(boardersPerBus ?? 0, BUS_SEATS);
    leg.seatLikely = leg.passengers + ahead < BUS_SEATS;
  } else {
    leg.seatLikely = leg.startsHere || leg.congestion === '여유' ? true : null;
  }
  return leg;
}

async function subwayLeg(sp, atSec, now) {
  const lane = sp.lane?.[0];
  const leg = {
    type: 'subway', line: lane?.name, from: sp.startName, to: sp.endName, way: sp.way,
    rideMin: sp.sectionTime, stations: sp.stationCount, stops: stopNames(sp),
    realtime: false, waitSec: null, congestion: null, notes: [], missProb: 0, extraWaitSec: 0, seatLikely: null,
  };
  const lineId = subwayIdFor(lane);
  const dirs = sp.wayCode === 1 ? ['상행', '내선'] : ['하행', '외선'];
  try {
    const st = await subwayStation(sp.startName);
    const train = st.trains
      .filter((t) => (!lineId || t.lineId === lineId) && dirs.includes(t.direction))
      .filter((t) => t.seconds != null && t.seconds >= atSec + BOARD_BUFFER_SEC)
      .sort((a, b) => a.seconds - b.seconds)[0];
    if (train) {
      leg.realtime = true;
      leg.waitSec = train.seconds - atSec;
      leg.heading = train.heading;
    }
  } catch (e) {
    leg.notes.push(`실시간 조회 실패: ${e.message}`);
  }
  if (leg.waitSec == null) {
    leg.waitSec = 180;
    leg.notes.push('도착 시점 열차는 아직 실시간 범위 밖 · 3분 대기로 추정');
  }

  // 서울교통공사 30분 단위 혼잡도 (평소 기준). 탑승역 값으로 좌석 판단, 지나가는 역 중 최댓값도 표시
  const boardAt = new Date(now + (atSec + leg.waitSec) * 1000);
  const passed = (sp.passStopList?.stations ?? []).slice(0, -1).map((s) => s.stationName);
  const stations = passed.length ? passed : [sp.startName];
  const pcts = stations.map((name) => ({ name, pct: subwayCongestion(lane, name, sp.wayCode, boardAt) }));
  const board = pcts[0];
  leg.stationCongestion = pcts.filter((p) => p.pct != null);
  if (board?.pct != null) {
    const peak = pcts.reduce((a, b) => ((b.pct ?? -1) > (a.pct ?? -1) ? b : a));
    leg.congestionPct = board.pct;
    leg.congestion = congestionLevel(board.pct);
    leg.seatLikely = board.pct < SUBWAY_SEAT_PCT;
    if (peak.pct > board.pct) leg.peak = { station: peak.name, pct: peak.pct, level: congestionLevel(peak.pct) };
  } else {
    leg.notes.push('혼잡도 통계 없음 (서울교통공사 1~8호선만 제공)');
  }
  return leg;
}

// 혼잡도 % = 정원(칸당 160명) 대비 탑승 비율. 좌석 54석 ≈ 34%
const SUBWAY_SEAT_PCT = 34;
function congestionLevel(pct) {
  if (pct < SUBWAY_SEAT_PCT) return '여유';
  if (pct < 80) return '보통';
  if (pct < 130) return '혼잡';
  return '매우혼잡';
}

function subwayCongestion(lane, station, wayCode, date) {
  const line = lane?.name?.match(/([1-8])호선/)?.[1];
  if (!line) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const day = parts.weekday === 'Sat' ? '토요일' : parts.weekday === 'Sun' ? '일요일' : '평일';
  const slot = `${parts.hour.padStart(2, '0')}:${Number(parts.minute) < 30 ? '00' : '30'}`;
  const idx = subwayStats.slots.indexOf(slot);
  const dirs = subwayStats.data[day]?.[`${line}호선`]?.[station.replace(/역$/, '')];
  if (idx < 0 || !dirs) return null;
  // ODsay wayCode 1 = 상행·내선, 2 = 하행·외선
  const values = wayCode === 1 ? dirs['상선'] ?? dirs['내선'] : dirs['하선'] ?? dirs['외선'];
  return values?.[idx] ?? null;
}

// ODsay 경로 하나를 실시간으로 다시 계산
export async function evaluatePath(path, now, firstWalkOverride, startSec = 0) {
  const legs = [];
  // startSec: 지금부터 몇 초 뒤에 출발하는지. 실시간 도착 정보는 항상 '지금' 기준이라 같은 시간축에서 계산
  let t = startSec;
  for (const [idx, sp] of path.subPath.entries()) {
    if (sp.trafficType === 3) {
      const sec = idx === 0 && firstWalkOverride ? firstWalkOverride.sec : sp.sectionTime * 60;
      if (sec > 0) {
        const overridden = !!firstWalkOverride && idx === 0;
        legs.push({
          type: 'walk', minutes: Math.round(sec / 60), estimated: overridden,
          to: overridden ? firstWalkOverride.to : null,
          distanceM: overridden ? null : sp.distance ?? null,
          startAt: new Date(now + t * 1000).toISOString(),
        });
      }
      t += sec;
      continue;
    }
    const isFirstRide = !legs.some((l) => l.type !== 'walk');
    const leg = sp.trafficType === 2
      ? await busLeg(sp, t, now, isFirstRide ? firstWalkOverride?.ars : undefined)
      : await subwayLeg(sp, t, now);
    leg.departAt = new Date(now + (t + leg.waitSec) * 1000).toISOString();
    t += leg.waitSec + leg.extraWaitSec + sp.sectionTime * 60;
    leg.arriveAt = new Date(now + t * 1000).toISOString();
    legs.push(leg);
  }
  return {
    legs,
    totalSec: t - startSec,
    leaveAt: new Date(now + startSec * 1000).toISOString(),
    arriveAt: new Date(now + t * 1000).toISOString(),
  };
}

// 첫 버스를 한 정류장 앞에서 타는 변형 경로
export async function upstreamVariant(path, origin, nearStops) {
  const firstIdx = path.subPath.findIndex((sp) => sp.trafficType !== 3);
  const sp = path.subPath[firstIdx];
  if (sp?.trafficType !== 2) return null;
  const stats = stopStats(sp.lane?.[0]?.busNo, sp.startArsID?.replace('-', ''));
  if (!stats?.prev || stats.startsHere) return null;
  const prevStop = nearStops.find((s) => s.ars === stats.prev.ars);
  if (!prevStop) return null;
  const d = distM(origin, prevStop);
  if (d > MAX_UPSTREAM_WALK_M) return null;
  return { sec: walkSecFromDist(d), ars: prevStop.ars, to: prevStop.name };
}

function signature(r) {
  return r.legs.filter((l) => l.type !== 'walk').map((l) => `${l.type}:${l.route ?? l.line}@${l.ars ?? l.from}`).join('>');
}

// 등교: 강의실까지 들어가는 여유 (건물별 도보 데이터가 생기면 대체)
const CLASS_BUFFER_SEC = 10 * 60;
// 등교 계산 시 첫 계산용 출발 시각 (수업 시작 몇 초 전)
const MORNING_PROBE_SEC = 100 * 60;

// direction 'home': origin(학교/GPS) → 집,  'school': 집 → origin 자리에 정문
// departAt: 이 시각에 출발 (기본 지금), arriveBy: 이 시각까지 도착 (등교)
export async function recommend({ origin, home, direction = 'home', mode = 'fast', departAt, arriveBy, now = Date.now() }) {
  const homeStation = await findStation(home);
  const [from, to] = direction === 'school'
    ? [homeStation, { ...MAIN_GATE, name: '국민대 정문' }]
    : [origin, homeStation];
  const leaveTarget = arriveBy ? arriveBy - MORNING_PROBE_SEC * 1000 : departAt ?? now;
  const startSec = Math.max(0, Math.round((leaveTarget - now) / 1000));

  // 캠퍼스 안에서 출발하면 경로는 정문·후문 기준점에서 받아 재사용하고 (ODsay 호출 절약),
  // 실제 위치에서 첫 정류장까지 걷는 시간만 따로 계산
  const onCampus = direction === 'home' && distM(origin, MAIN_GATE) <= CAMPUS_RADIUS_M;
  const anchors = onCampus ? [MAIN_GATE, BACK_GATE] : [from];
  // 기준점 하나가 실패해도(예: ODsay 일일 한도) 나머지로 추천
  const settled = await Promise.allSettled(anchors.map(async (a) =>
    (await searchPaths(a, to)).slice(0, 5).map((path) => ({ path, anchor: a })),
  ));
  const paths = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  if (!paths.length) throw settled.find((s) => s.status === 'rejected')?.reason ?? new Error('경로를 찾지 못했어요');
  const nearStops = direction === 'home'
    ? await busStopsNear(from.lat, from.lng, MAX_UPSTREAM_WALK_M).catch(() => [])
    : [];

  const walkFromOrigin = (path, anchor) => {
    if (!onCampus || distM(origin, anchor) < 30) return null;
    const first = path.subPath.find((sp) => sp.trafficType !== 3);
    if (!first?.startY) return null;
    const stop = { lat: Number(first.startY), lng: Number(first.startX) };
    return { sec: walkSecFromDist(distM(origin, stop)), to: first.startName };
  };

  // 등교는 첫 계산으로 소요 시간을 구한 뒤, 실제 출발 시각으로 한 번 더 계산 (혼잡도 시간대·실시간 반영)
  const run = async (path, variant, tags) => {
    let r = await evaluatePath(path, now, variant, startSec);
    if (arriveBy) {
      const refined = Math.max(0, Math.round((arriveBy - now) / 1000 - r.totalSec - CLASS_BUFFER_SEC));
      r = await evaluatePath(path, now, variant, refined);
    }
    return { ...r, tags };
  };
  const jobs = [];
  for (const { path, anchor } of paths) {
    jobs.push(run(path, walkFromOrigin(path, anchor), []));
    jobs.push(upstreamVariant(path, from, nearStops).then((v) => v && run(path, v, [`${v.to}까지 걸어서 먼저 타기`])));
  }
  const results = (await Promise.all(jobs)).filter(Boolean);

  const seen = new Set();
  const unique = results.filter((r) => {
    const s = signature(r);
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  for (const r of unique) {
    const first = r.legs.find((l) => l.type !== 'walk');
    if (first?.startsHere) r.tags.push('국민대에서 출발하는 차');
    const standingSec = r.legs
      .filter((l) => l.type !== 'walk' && l.seatLikely === false)
      .reduce((s, l) => s + l.rideMin * 60, 0);
    r.standingMin = Math.round(standingSec / 60);
    // 편한 순: 서서 가는 시간 1분을 도착 0.5분 늦는 것과 같게 취급
    r.score = r.totalSec + (mode === 'comfort' ? standingSec * 0.5 : 0);
    if (arriveBy) {
      // 소요 시간을 거꾸로 빼서 '늦어도 이때는 나가야 함', 구간 시각도 그 출발 기준으로 옮김
      const leaveBy = arriveBy - (r.totalSec + CLASS_BUFFER_SEC) * 1000;
      const shift = leaveBy - Date.parse(r.leaveAt);
      const move = (iso) => new Date(Date.parse(iso) + shift).toISOString();
      for (const l of r.legs) {
        if (l.departAt) l.departAt = move(l.departAt);
        if (l.arriveAt) l.arriveAt = move(l.arriveAt);
        if (l.startAt) l.startAt = move(l.startAt);
      }
      r.leaveBy = r.leaveAt = new Date(leaveBy).toISOString();
      r.arriveAt = move(r.arriveAt);
    }
  }
  unique.sort((a, b) => a.score - b.score);

  return {
    direction, from, to, mode,
    destination: to,
    arriveBy: arriveBy ? new Date(arriveBy).toISOString() : null,
    classBufferMin: arriveBy ? CLASS_BUFFER_SEC / 60 : null,
    generatedAt: new Date(now).toISOString(),
    routes: unique.slice(0, 5),
  };
}
