// 하교 경로 추천 엔진
// ODsay로 경로 후보를 받고, 각 구간을 서울시 실시간 도착·탑승 인원과 승하차 통계로 다시 계산한다.
import { busStop, busStopsNear, subwayStation, subwayTimetable } from './_transit.js';
import { findStation, searchPaths } from './_odsay.js';
import { walkRoute } from './_walk.js';
import { weatherAt } from './_weather.js';
import { kakao } from './_kakao.js';
import { listReports, summarize, REPORT_APPLY_SEC } from './_reports.js';
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
// 실시간 혼잡 정보가 없을 때: 평소 한 대당 탑승 인원이 좌석보다 많으면 0.2, 아니면 0.05
const MISS_PROB_BUSY = 0.2;
const MISS_PROB_QUIET = 0.05;
// '운행종료' 메시지를 믿는 범위. 이보다 먼 출발이면 지금 운행종료여도 그때는 다닐 수 있음
const ENDED_TRUST_SEC = 3 * 3600;
// 기점 막차 출발 후 이 시간이 지나면 국민대 근처도 끊긴 것으로 봄
const LAST_BUS_SLACK_SEC = 2 * 3600;
// 비·눈 올 때 도보 시간 배율, 버스 못 탈 확률 가산
const WEATHER_WALK = { 비: 1.15, '비/눈': 1.2, 눈: 1.25, 소나기: 1.15, 빗방울: 1.05, '빗방울·눈날림': 1.1, 눈날림: 1.1 };
// 실시간 탑승 시간이 평소(ODsay)와 이만큼 넘게 다르면 경로 설명에 표시
const LIVE_RIDE_NOTE_SEC = 120;
const RAIN_MISS_ADD = 0.1;
// 편한 순 가중치: 서서 가는 1분 = +0.5분, 좌석 여부 모르는 1분 = +0.25분(반반), 환승 1회 = +2분
const COMFORT = { standing: 0.5, unknownSeat: 0.25, transferSec: 120 };

// ODsay 노선 이름 → 서울 실시간 지하철 API subwayId
const SUBWAY_IDS = { 우이신설: '1092', 경의중앙: '1063', 공항: '1065', 경춘: '1067', 수인분당: '1075', 신분당: '1077', 서해: '1093', 신림: '1094' };

function subwayIdFor(lane) {
  const code = Number(lane?.subwayCode);
  if (code >= 1 && code <= 9) return `100${code}`;
  const hit = Object.keys(SUBWAY_IDS).find((k) => lane?.name?.includes(k));
  return hit ? SUBWAY_IDS[hit] : null;
}

// KST 기준 { day(0=일), sec(자정부터 초) }
function kstClock(date) {
  const d = new Date(date.getTime() + 9 * 3600e3);
  return { day: d.getUTCDay(), sec: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() };
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

// 지도 보행 경로로 도보 시간 계산, 안 되면 직선거리 추정
async function walkBetween(a, b) {
  const osm = await walkRoute(a, b);
  if (osm) return osm;
  const d = distM(a, b);
  return { sec: walkSecFromDist(d), distanceM: Math.round(d * WALK_DETOUR), source: 'estimate' };
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

async function busLeg(sp, atSec, now, arsOverride, ctx = {}) {
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
      leg.dataAt = stopData.fetchedAt;
      route = matchRoute(stopData, busNo);
    } catch (e) {
      leg.notes.push(`실시간 조회 실패: ${e.message}`);
    }
  }
  const headwaySec = ((route?.headwayMin || Number(sp.intervalTime)) || 10) * 60;

  const catchable = route?.arrivals.find((a) => a.seconds != null && a.seconds >= atSec + BOARD_BUFFER_SEC);
  if (catchable) {
    leg.realtime = true;
    if (catchable.last) {
      leg.lastVehicle = true;
      leg.notes.push('막차');
    }
    leg.waitSec = catchable.seconds - atSec;
    leg.congestion = catchable.congestion;
    leg.passengers = catchable.passengers;
    leg.full = catchable.full;
    leg.stopsAway = catchable.stopsAway;
    // 이 차를 놓치면 탈 다음 차
    const after = route.arrivals.find((a) => a !== catchable && a.seconds != null && a.seconds > catchable.seconds);
    if (after) leg.nextVehicle = { waitSec: after.seconds - atSec, passengers: after.passengers, congestion: after.congestion, stopsAway: after.stopsAway };
    // 도로 정체 반영: 내릴 정류장에도 같은 차(vehId)가 보이면 두 도착 예정 시각의 차가 지금 도로 사정의 탑승 시간
    // (내릴 정류장 앞에 다른 차가 2대 넘게 있으면 안 보여서 평소 시간 그대로)
    const endArs = (sp.endArsID ?? sp.passStopList?.stations?.at(-1)?.arsID)?.replace('-', '');
    // 길안내: 타고 가는 동안 내릴 정류장의 같은 차 도착 예정으로 지연을 확인
    leg.vehId = catchable.vehId;
    leg.endArs = endArs;
    if (catchable.vehId && endArs && endArs !== ars) {
      try {
        const dest = matchRoute(await busStop(endArs), busNo);
        const same = dest?.arrivals.find((a) => a.vehId === catchable.vehId && a.seconds != null);
        if (same && same.seconds > catchable.seconds) {
          const liveSec = same.seconds - catchable.seconds;
          leg.liveRideSec = liveSec;
          leg.rideMin = Math.round(liveSec / 60);
          if (Math.abs(liveSec - sp.sectionTime * 60) >= LIVE_RIDE_NOTE_SEC) {
            leg.notes.push(`지금 도로 사정으로 ${leg.rideMin}분 탑승 (평소 ${sp.sectionTime}분)`);
          }
        }
      } catch {}
    }
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
      const msg = route?.arrivals[0]?.message?.trim();
      if (msg?.includes('운행종료') && atSec < ENDED_TRUST_SEC) {
        leg.ended = true;
        leg.notes.push('오늘 운행 종료');
      } else {
        leg.notes.push(msg ? `${msg} · 배차간격으로 추정` : '실시간 정보 없음 · 배차간격으로 추정');
      }
    }
  }
  // 실시간 범위 밖이면 기점 첫차·막차 시각으로 판단 (정류장 통과 시각은 기점보다 늦어서 '확인 필요'로만 경고)
  if (!catchable && !leg.ended && route?.lastTm) {
    const hm = (s) => Number(s.slice(0, 2)) * 3600 + Number(s.slice(2, 4)) * 60;
    const board = serviceClock(new Date(now + (atSec + leg.waitSec) * 1000)).sec;
    let last = hm(route.lastTm);
    if (last < 4 * 3600) last += 86400;
    const first = route.firstTm ? hm(route.firstTm) : null;
    if ((first != null && board < first) || board > last + LAST_BUS_SLACK_SEC) {
      leg.ended = true;
      leg.notes.push(`운행 시간 아님 (기점 첫차 ${route.firstTm.slice(0, 2)}:${route.firstTm.slice(2)} · 막차 ${route.lastTm.slice(0, 2)}:${route.lastTm.slice(2)})`);
    } else if (board > last) {
      leg.lastRisk = true;
      leg.notes.push(`막차 확인 필요 (기점 막차 ${route.lastTm.slice(0, 2)}:${route.lastTm.slice(2)} 출발)`);
    }
  }
  // 실시간으로 보이는 마지막 차가 막차인데 그걸 놓치면 오늘은 끝
  if (!catchable && !leg.ended && route?.arrivals.some((a) => a.last) && atSec < ENDED_TRUST_SEC) {
    leg.ended = true;
    leg.notes.push('막차를 놓침');
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
  let miss = leg.full ? 0.9 : MISS_PROB[leg.congestion]
    ?? (boardersPerBus != null && boardersPerBus > BUS_SEATS ? MISS_PROB_BUSY : MISS_PROB_QUIET);
  if (ctx.weather?.precip) miss = Math.min(0.9, miss + RAIN_MISS_ADD);
  if (leg.passengers != null && boardersPerBus != null && leg.passengers + boardersPerBus > BUS_CAPACITY) {
    miss = Math.max(miss, 0.5);
    leg.notes.push(`평소 이 시간 한 대당 ${boardersPerBus}명 탑승 · 만차 위험`);
  }
  // 학우 줄 제보: 곧 탈 버스(20분 안)에만, 버스 혼잡도와 같은 기준(보통 10%·혼잡 40%)으로 못 탈 확률 하한
  const report = ars && ctx.reports && atSec + leg.waitSec <= REPORT_APPLY_SEC ? summarize(ctx.reports, ars, now) : null;
  if (report) {
    leg.report = report;
    const floor = MISS_PROB[report.label] ?? 0;
    if (floor > miss) {
      miss = floor;
      leg.notes.push(`학우 제보 '${report.label}' ${report.count}건 (${report.agoMin}분 전) · 못 탈 확률 ${Math.round(floor * 100)}% 반영`);
    }
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

// 서울 지하철은 새벽 4시 전이면 전날 운행 일정의 24시 이후 열차
function serviceClock(date) {
  const k = kstClock(date);
  if (k.sec < 4 * 3600) {
    return { week: kstClock(new Date(date.getTime() - 86400e3)).day, sec: k.sec + 86400 };
  }
  return { week: k.day, sec: k.sec };
}
const weekTag = (day) => (day === 0 ? 3 : day === 6 ? 2 : 1);

async function subwayLeg(sp, atSec, now) {
  const lane = sp.lane?.[0];
  const leg = {
    type: 'subway', line: lane?.name, from: sp.startName, to: sp.endName, way: sp.way,
    rideMin: sp.sectionTime, stations: sp.stationCount, stops: stopNames(sp),
    realtime: false, waitSec: null, congestion: null, notes: [], missProb: 0, extraWaitSec: 0, seatLikely: null,
  };
  const lineId = subwayIdFor(lane);
  const dirs = sp.wayCode === 1 ? ['상행', '내선'] : ['하행', '외선'];
  // 길안내가 역에 실제 도착한 뒤 같은 노선·방향 열차를 다시 찾을 때 사용
  Object.assign(leg, { lineId, dirs });
  try {
    const st = await subwayStation(sp.startName);
    const train = st.trains
      .filter((t) => (!lineId || t.lineId === lineId) && dirs.includes(t.direction))
      .filter((t) => t.seconds != null && t.seconds >= atSec + BOARD_BUFFER_SEC)
      .sort((a, b) => a.seconds - b.seconds)[0];
    if (train) {
      leg.realtime = true;
      leg.dataAt = st.fetchedAt;
      leg.waitSec = train.seconds - atSec;
      leg.heading = train.heading;
      if (train.last) {
        leg.lastVehicle = true;
        leg.notes.push('막차');
      }
    }
  } catch (e) {
    leg.notes.push(`실시간 조회 실패: ${e.message}`);
  }
  // 실시간 범위 밖이면 시간표 (1~8호선)
  const lineNo = Number(lane?.subwayCode);
  if (leg.waitSec == null && lineNo >= 1 && lineNo <= 8 && sp.wayCode) {
    try {
      const at = serviceClock(new Date(now + (atSec + BOARD_BUFFER_SEC) * 1000));
      const table = await subwayTimetable(sp.startName, lineNo, sp.wayCode, weekTag(at.week));
      if (table.length) {
        const next = table.find((t) => t.sec >= at.sec);
        if (next) {
          leg.timetable = true;
          leg.waitSec = next.sec - at.sec + BOARD_BUFFER_SEC;
          leg.heading = `${next.heading}행`;
          leg.notes.push('시간표 기준');
          if (next === table[table.length - 1]) {
            leg.lastVehicle = true;
            leg.notes.push('막차');
          }
        } else {
          leg.ended = true;
          leg.waitSec = 0;
          leg.notes.push('막차 시간이 지났어요');
        }
      }
    } catch (e) {
      leg.notes.push(`시간표 조회 실패: ${e.message}`);
    }
  }
  if (leg.waitSec == null) {
    leg.waitSec = 180;
    leg.notes.push(lineNo >= 1 && lineNo <= 8 ? '실시간·시간표 없음 · 3분 대기로 추정' : '시간표 미제공 노선 · 3분 대기로 추정');
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
// walkFactor: 사용자 걸음 속도 배율 (도착 버튼으로 잰 실제 시간 ÷ 지도 시간). 1.2면 지도보다 20% 느림
// ctx.weather: 출발 시각 날씨 (비면 버스 못 탈 확률 가산). 도보 날씨 배율은 walkFactor에 포함해서 받음
// ctx.lastWalk: 등교 때 마지막 도보를 '하차 정류장 → 수업 건물'로 바꿈 { sec, distanceM, to, toPos }
export async function evaluatePath(path, now, firstWalkOverride, startSec = 0, walkFactor = 1, ctx = {}) {
  const legs = [];
  const parts = { walkSec: 0, waitSec: 0, extraWaitSec: 0, rideSec: 0 };
  // startSec: 지금부터 몇 초 뒤에 출발하는지. 실시간 도착 정보는 항상 '지금' 기준이라 같은 시간축에서 계산
  let t = startSec;
  for (const [idx, sp] of path.subPath.entries()) {
    if (sp.trafficType === 3) {
      const isLast = idx === path.subPath.length - 1 && !!ctx.lastWalk;
      const override = isLast ? ctx.lastWalk : idx === 0 ? firstWalkOverride : null;
      const baseSec = override ? override.sec : sp.sectionTime * 60;
      const sec = Math.round(baseSec * walkFactor);
      if (sec > 0) {
        const overridden = !!override;
        legs.push({
          type: 'walk', sec, baseSec, minutes: Math.round(sec / 60), estimated: overridden && override.source !== 'osm',
          to: overridden ? override.to : null,
          toPos: overridden ? override.toPos ?? null : null,
          distanceM: overridden ? override.distanceM ?? null : sp.distance ?? null,
          uphill: isLast ? CAMPUS_UPHILL : undefined,
          startAt: new Date(now + t * 1000).toISOString(),
        });
      }
      t += sec;
      parts.walkSec += sec;
      continue;
    }
    const isFirstRide = !legs.some((l) => l.type !== 'walk');
    const leg = sp.trafficType === 2
      ? await busLeg(sp, t, now, isFirstRide ? firstWalkOverride?.ars : undefined, ctx)
      : await subwayLeg(sp, t, now);
    // 실시간 길안내용 좌표: 탑승·하차 정류장, 하차 직전 정류장(내릴 준비 안내), 지하철 나갈 출구
    const pos = (y, x) => (y && x ? { lat: Number(y), lng: Number(x) } : null);
    leg.fromPos = (isFirstRide && firstWalkOverride?.ars && firstWalkOverride.toPos) || pos(sp.startY, sp.startX);
    leg.toPos = pos(sp.endY, sp.endX);
    const passed = sp.passStopList?.stations ?? [];
    const before = passed.length >= 3 ? passed[passed.length - 2] : null;
    leg.preStop = before ? { name: before.stationName, ...pos(before.y, before.x) } : null;
    if (sp.trafficType === 1 && sp.endExitNo) leg.exitNo = sp.endExitNo;
    leg.departAt = new Date(now + (t + leg.waitSec) * 1000).toISOString();
    const rideSec = leg.liveRideSec ?? sp.sectionTime * 60;
    t += leg.waitSec + leg.extraWaitSec + rideSec;
    parts.waitSec += leg.waitSec;
    parts.extraWaitSec += leg.extraWaitSec;
    parts.rideSec += rideSec;
    leg.arriveAt = new Date(now + t * 1000).toISOString();
    legs.push(leg);
  }
  return {
    legs,
    // 총 소요 = 도보 + 대기 + 만차 대비 추가 대기 + 탑승 (환승 도보는 도보에 포함)
    breakdown: parts,
    unavailable: legs.some((l) => l.ended),
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
  return { ...(await walkBetween(origin, prevStop)), ars: prevStop.ars, to: prevStop.name, toPos: { lat: prevStop.lat, lng: prevStop.lng } };
}

function signature(r) {
  return r.legs.filter((l) => l.type !== 'walk').map((l) => `${l.type}:${l.route ?? l.line}@${l.ars ?? l.from}-${l.to}`).join('>');
}

// 등교: 강의실 건물을 못 찾을 때 정문 → 강의실 여유
const CLASS_BUFFER_SEC = 10 * 60;
// 정문 → 건물은 오르막이라 지도 보행 시간에 곱하는 배율(가정값, 실측으로 바꿀 것) + 건물 들어가서 강의실까지
const CAMPUS_UPHILL = 1.3;
const INDOOR_SEC = 3 * 60;
const buildingMemo = new Map();

// '미래관6층11호실' → '미래관' 좌표 (카카오 장소 검색, 정문 반경 1.5km)
async function findBuilding(room) {
  const name = room?.replace(/\s*\d.*$/, '').trim();
  if (!name) return null;
  if (!buildingMemo.has(name)) {
    buildingMemo.set(name, kakao('keyword', `국민대학교 ${name}`, { x: MAIN_GATE.lng, y: MAIN_GATE.lat, radius: 1500 })
      .then((docs) => {
        // '복지관' → 정릉종합사회복지관처럼 엉뚱한 곳이 잡히지 않게
        const d = docs.find((x) => x.place_name.includes('국민대') && x.place_name.includes(name));
        return d ? { name, lat: Number(d.y), lng: Number(d.x) } : null;
      })
      .catch(() => { buildingMemo.delete(name); return null; }));
  }
  return buildingMemo.get(name);
}

// 하차 정류장 → 수업 건물 도보 (캠퍼스는 오르막이라 지도 시간 × CAMPUS_UPHILL)
async function walkToBuilding(path, building) {
  const last = [...path.subPath].reverse().find((sp) => sp.trafficType !== 3);
  if (!last?.endY) return null;
  const stop = { lat: Number(last.endY), lng: Number(last.endX) };
  const w = await walkBetween(stop, building);
  return { ...w, sec: Math.round(w.sec * CAMPUS_UPHILL), to: building.name, toPos: { lat: building.lat, lng: building.lng }, stop };
}
// 등교 계산 시 첫 계산용 출발 시각 (수업 시작 몇 초 전)
const MORNING_PROBE_SEC = 100 * 60;

// direction 'home': origin(학교/GPS) → 집,  'school': 집 → origin 자리에 정문
// departAt: 이 시각에 출발 (기본 지금), arriveBy: 이 시각까지 도착 (등교)
// home: 역 이름("연신내") 또는 상세주소 좌표 { name, lat, lng }
export async function recommend({ origin, home, direction = 'home', mode = 'fast', departAt, arriveBy, room, walkFactor = 1, now = Date.now() }) {
  const homeStation = typeof home === 'string'
    ? { ...(await findStation(home)), kind: 'station' }
    : { ...home, kind: 'address' };
  // 등교: 첫 수업 건물까지 (건물을 모르면 정문)
  const building = direction === 'school' ? await findBuilding(room) : null;
  const [from, to] = direction === 'school'
    ? [homeStation, building ? { ...building, name: `국민대 ${building.name}`, kind: 'building' } : { ...MAIN_GATE, name: '국민대 정문' }]
    : [origin, homeStation];
  const leaveTarget = arriveBy ? arriveBy - MORNING_PROBE_SEC * 1000 : departAt ?? now;
  const startSec = Math.max(0, Math.round((leaveTarget - now) / 1000));
  const buffer = !arriveBy ? null : building
    ? { sec: INDOOR_SEC, building: building.name, basis: `${building.name}까지 걷는 시간은 경로에 포함 · 건물 안 ${INDOOR_SEC / 60}분` }
    : { sec: CLASS_BUFFER_SEC, basis: room ? `'${room}'에서 건물을 못 찾아 정문 + 10분` : '강의실 정보 없음 · 정문 + 10분' };
  const weather = await weatherAt(MAIN_GATE, now + startSec * 1000, now).catch(() => null);
  // 정류장 줄 제보 (실패해도 추천은 계속)
  const reports = await listReports(now).catch(() => []);
  const ctx = { weather, reports };
  const walkMul = walkFactor * (WEATHER_WALK[weather?.precip] ?? 1);

  // 캠퍼스 안에서 출발하면 경로는 정문·후문 기준점에서 받아 재사용하고 (ODsay 호출 절약),
  // 실제 위치에서 첫 정류장까지 걷는 시간만 따로 계산
  const onCampus = direction === 'home' && distM(origin, MAIN_GATE) <= CAMPUS_RADIUS_M;
  const anchors = onCampus ? [MAIN_GATE, BACK_GATE] : [from];
  // 등교: 정문·후문 두 곳까지 경로를 받고(집마다 저장해 두면 건물이 바뀌어도 재사용) 내린 곳 → 건물 도보를 붙임
  const goals = building ? [MAIN_GATE, BACK_GATE] : [to];
  // 기준점 하나가 실패해도(예: ODsay 일일 한도) 나머지로 추천
  const pathSources = [];
  const search = (list) => Promise.allSettled(list.flatMap((a) => goals.map(async (g) => {
    const found = await searchPaths(a, g);
    pathSources.push({ source: found.source, at: found.at });
    return found.paths.slice(0, 5).map((path) => ({ path, anchor: a }));
  })));
  let settled = await search(anchors);
  let paths = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  // 캠퍼스 밖 GPS에서 경로를 못 찾으면 정문 기준(저장돼 있을 가능성 높음)으로 다시
  let fallback = null;
  if (!paths.length && direction === 'home' && !onCampus && origin.source === 'gps') {
    settled = await search([MAIN_GATE]);
    paths = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
    if (paths.length) fallback = '현재 위치로 경로를 못 찾아서 정문 기준으로 보여줘요';
  }
  if (!paths.length) throw settled.find((s) => s.status === 'rejected')?.reason ?? new Error('경로를 찾지 못했어요');
  const nearStops = direction === 'home'
    ? await busStopsNear(from.lat, from.lng, MAX_UPSTREAM_WALK_M).catch(() => [])
    : [];

  const walkFromOrigin = async (path, anchor) => {
    if (!onCampus || distM(origin, anchor) < 30) return null;
    const first = path.subPath.find((sp) => sp.trafficType !== 3);
    if (!first?.startY) return null;
    const stop = { lat: Number(first.startY), lng: Number(first.startX) };
    return { ...(await walkBetween(origin, stop)), to: first.startName, toPos: stop };
  };

  // 등교는 첫 계산으로 소요 시간을 구한 뒤, 실제 출발 시각으로 한 번 더 계산 (혼잡도 시간대·실시간 반영)
  const run = async (path, variant, tags) => {
    const lastWalk = building ? await walkToBuilding(path, building) : null;
    const pathCtx = { ...ctx, lastWalk };
    let r = await evaluatePath(path, now, variant, startSec, walkMul, pathCtx);
    if (arriveBy) {
      const refined = Math.max(0, Math.round((arriveBy - now) / 1000 - r.totalSec - buffer.sec));
      r = await evaluatePath(path, now, variant, refined, walkMul, pathCtx);
    }
    // 어디서 내려서 건물까지 몇 분 (예: 과학관이면 정문보다 청덕초 정류장이 가까움)
    if (lastWalk) {
      const stopName = r.legs.filter((l) => l.type !== 'walk').at(-1)?.to;
      tags = [`${stopName} 하차 → ${building.name} 도보 ${Math.round((lastWalk.sec * walkMul) / 60)}분`, ...tags];
    }
    return { ...r, tags, pathSource: path.source ?? 'odsay' };
  };
  const jobs = [];
  for (const { path, anchor } of paths) {
    jobs.push(walkFromOrigin(path, anchor).then((w) => run(path, w, [])));
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
    if (r.legs.some((l) => l.lastVehicle)) r.tags.push('막차');
    else if (r.legs.some((l) => l.lastRisk)) r.tags.push('막차 확인 필요');
    if (r.unavailable) r.tags.push('운행 종료 노선 포함');
    const rides = r.legs.filter((l) => l.type !== 'walk');
    const rideSecWhere = (pred) => rides.filter(pred).reduce((s, l) => s + l.rideMin * 60, 0);
    const standingSec = rideSecWhere((l) => l.seatLikely === false);
    const unknownSeatSec = rideSecWhere((l) => l.seatLikely == null);
    const transfers = Math.max(0, rides.length - 1);
    r.standingMin = Math.round(standingSec / 60);
    // 빠른 순: 도착 시각(= 총 소요). 편한 순: 총 소요 + 서서 가는 시간·좌석 모르는 시간·환승 벌점
    const penaltySec = mode === 'comfort'
      ? Math.round(standingSec * COMFORT.standing + unknownSeatSec * COMFORT.unknownSeat + transfers * COMFORT.transferSec)
      : 0;
    r.scoreDetail = { mode, totalSec: r.totalSec, standingSec, unknownSeatSec, transfers, penaltySec };
    // 운행 종료 노선이 낀 경로는 맨 아래로
    r.score = r.totalSec + penaltySec + (r.unavailable ? 1e7 : 0);
    if (arriveBy) {
      // 소요 시간을 거꾸로 빼서 '늦어도 이때는 나가야 함', 구간 시각도 그 출발 기준으로 옮김
      const leaveBy = arriveBy - (r.totalSec + buffer.sec) * 1000;
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
  const routes = unique.slice(0, 5);

  return {
    direction, from, to, mode,
    destination: to,
    arriveBy: arriveBy ? new Date(arriveBy).toISOString() : null,
    classBufferMin: arriveBy ? Math.round(buffer.sec / 60) : null,
    classBuffer: buffer,
    building: building ?? null,
    generatedAt: new Date(now).toISOString(),
    weather,
    walkFactor: walkMul,
    fallback,
    sources: dataSources(routes, pathSources, weather),
    routes,
  };
}

// 화면에 보여줄 정보 출처와 갱신 시각
function dataSources(routes, pathSources, weather) {
  const legs = routes.flatMap((r) => r.legs);
  const newest = (list) => list.filter(Boolean).sort().at(-1) ?? null;
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const out = [];
  const odsay = pathSources.filter((p) => p.source !== 'seoul');
  if (odsay.length) {
    out.push({
      what: '경로 후보', by: odsay.some((p) => p.source === 'odsay-stale') ? 'ODsay (한도 초과로 예전 저장본)' : 'ODsay 길찾기',
      at: iso(Math.min(...odsay.map((p) => p.at ?? Date.now()))), note: '노선 구성은 최대 7일 저장',
    });
  }
  if (pathSources.some((p) => p.source === 'seoul')) {
    out.push({ what: '경로 후보', by: '서울시 대중교통 환승경로 (대체)', at: iso(Date.now()), note: '구간 시간은 거리 비율로 추정' });
  }
  const busLive = legs.filter((l) => l.type === 'bus' && l.realtime);
  if (busLive.length) out.push({ what: '버스 도착·혼잡', by: '서울시 버스도착정보', at: newest(busLive.map((l) => l.dataAt)) });
  const subLive = legs.filter((l) => l.type === 'subway' && l.realtime);
  if (subLive.length) out.push({ what: '지하철 도착', by: '서울시 실시간 지하철', at: newest(subLive.map((l) => l.dataAt)) });
  if (legs.some((l) => l.timetable)) out.push({ what: '지하철 시간표', by: '서울 열린데이터광장', at: null, note: '평일·토·휴일 시간표' });
  if (legs.some((l) => l.stationCongestion?.length)) out.push({ what: '지하철 혼잡도', by: '서울교통공사 30분 단위 통계', at: null, note: '평소 기준' });
  if (legs.some((l) => l.typicalBoarders != null)) out.push({ what: '버스 탑승 인원', by: `서울시 교통카드 승하차 통계 (${profile.month.slice(0, 4)}.${profile.month.slice(4)})`, at: null, note: '평일 평균' });
  if (legs.some((l) => l.type === 'walk')) out.push({ what: '도보', by: 'OpenStreetMap 보행 경로', at: null, note: '내 걸음 속도 배율 반영' });
  if (legs.some((l) => l.report)) out.push({ what: '정류장 줄', by: '학우 제보', at: null, note: '15분 안 제보만 · 보통 10%·혼잡 40%를 못 탈 확률 하한으로' });
  if (weather) out.push({ what: '날씨', by: `기상청 ${weather.source ?? '초단기예보'}`, at: null, note: `${weather.at} · ${weather.forTime} 예보` });
  return out;
}
