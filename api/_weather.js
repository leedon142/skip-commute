// 기상청 초단기예보·단기예보 (공공데이터포털 VilageFcstInfoService_2.0)
// 출발 시각에 비·눈이 오는지 → 도보 시간·버스 혼잡 보정에 사용
// 5시간 안은 초단기예보(1시간 단위, 더 정확), 그 뒤(전날 밤에 맞추는 등교 알람 등)는 단기예보(약 3일)
import { fetchJsonAt, serviceKey } from './_lib.js';

const BASE = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
// 초단기: 1 비 2 비/눈 3 눈 5 빗방울 6 빗방울눈날림 7 눈날림 · 단기: 1 비 2 비/눈 3 눈 4 소나기
const PTY = { 1: '비', 2: '비/눈', 3: '눈', 4: '소나기', 5: '빗방울', 6: '빗방울·눈날림', 7: '눈날림' };
const ULTRA_MAX_MS = 5 * 3600e3; // 초단기예보가 확실히 덮는 범위 (발표 시각 + 6시간 중 앞쪽)
const VILAGE_MAX_MS = 60 * 3600e3;
// 단기예보 발표: 02·05·08·11·14·17·20·23시, 10분쯤부터 조회 가능
const VILAGE_HOURS = [23, 20, 17, 14, 11, 8, 5, 2];

// 위경도 → 기상청 격자 (Lambert Conformal Conic, 기상청 공개 변환식)
export function toGrid(lat, lng) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0, OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const D = Math.PI / 180;
  const re = RE / GRID, slat1 = SLAT1 * D, slat2 = SLAT2 * D, olon = OLON * D, olat = OLAT * D;
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  const ro = (re * sf) / Math.pow(Math.tan(Math.PI * 0.25 + olat * 0.5), sn);
  const ra = (re * sf) / Math.pow(Math.tan(Math.PI * 0.25 + lat * D * 0.5), sn);
  let theta = lng * D - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5) };
}

// KST 'YYYYMMDD', 'HHmm'
function kstParts(ms) {
  const d = new Date(ms + 9 * 3600e3).toISOString();
  return { date: d.slice(0, 10).replace(/-/g, ''), hm: d.slice(11, 13) + d.slice(14, 16) };
}

// 반환: { precip: '비'|null, rainMm, tempC, pop(강수확률, 단기만), at(발표 시각), forTime, source } 또는 키가 없거나 범위 밖이면 null
export async function weatherAt(pos, whenMs, now = Date.now()) {
  const raw = process.env.KMA_KEY;
  if (!raw || whenMs - now > VILAGE_MAX_MS) return null;
  const ultra = whenMs - now <= ULTRA_MAX_MS;
  let base, baseTime;
  if (ultra) {
    // 매시 30분 발표, 45분쯤부터 조회 가능
    base = kstParts(now - 45 * 60e3);
    baseTime = base.hm.slice(0, 2) + '30';
  } else {
    base = kstParts(now - 10 * 60e3);
    const h = VILAGE_HOURS.find((x) => x <= Number(base.hm.slice(0, 2)));
    if (h == null) base = kstParts(now - 24 * 3600e3); // 0~2시: 전날 23시 발표
    baseTime = `${String(h ?? 23).padStart(2, '0')}00`;
  }
  const { nx, ny } = toGrid(pos.lat, pos.lng);
  const qs = new URLSearchParams({ pageNo: 1, numOfRows: ultra ? 60 : 1000, dataType: 'JSON', base_date: base.date, base_time: baseTime, nx, ny });
  const { data } = await fetchJsonAt(`${BASE}/${ultra ? 'getUltraSrtFcst' : 'getVilageFcst'}?serviceKey=${serviceKey(raw)}&${qs}`);
  const items = data.response?.body?.items?.item ?? [];
  if (!items.length) return null;
  // 출발 시각이 속한 정시 예보, 없으면 가장 가까운 첫 예보
  const want = kstParts(Math.max(whenMs, now));
  const slot = `${want.date}${want.hm.slice(0, 2)}00`;
  const times = [...new Set(items.map((i) => i.fcstDate + i.fcstTime))].sort();
  const pick = times.includes(slot) ? slot : ultra ? times[0] : null;
  if (!pick) return null;
  const v = Object.fromEntries(items.filter((i) => i.fcstDate + i.fcstTime === pick).map((i) => [i.category, i.fcstValue]));
  const rain = v.RN1 ?? v.PCP;
  const temp = v.T1H ?? v.TMP;
  return {
    precip: PTY[Number(v.PTY)] ?? null,
    rainMm: rain && rain !== '강수없음' ? rain : null,
    tempC: temp != null ? Number(temp) : null,
    pop: v.POP != null ? Number(v.POP) : null,
    source: ultra ? '초단기예보' : '단기예보',
    at: `${base.date.slice(4, 6)}/${base.date.slice(6)} ${baseTime.slice(0, 2)}:${baseTime.slice(2)} 발표`,
    forTime: `${pick.slice(8, 10)}:${pick.slice(10)}`,
  };
}
