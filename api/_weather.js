// 기상청 초단기예보 (공공데이터포털 VilageFcstInfoService_2.0/getUltraSrtFcst)
// 출발 시각(6시간 이내)에 비·눈이 오는지 → 도보 시간·버스 혼잡 보정에 사용
import { fetchJsonAt, serviceKey } from './_lib.js';

const BASE = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtFcst';
const PTY = { 1: '비', 2: '비/눈', 3: '눈', 5: '빗방울', 6: '빗방울·눈날림', 7: '눈날림' };

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

// 반환: { precip: '비'|null, rainMm, tempC, at(발표 시각), forTime } 또는 키가 없거나 6시간 넘게 뒤면 null
export async function weatherAt(pos, whenMs, now = Date.now()) {
  const raw = process.env.KMA_KEY;
  if (!raw || whenMs - now > 6 * 3600e3) return null;
  // 매시 30분 발표, 45분쯤부터 조회 가능
  const base = kstParts(now - 45 * 60e3);
  const baseTime = base.hm.slice(0, 2) + '30';
  const { nx, ny } = toGrid(pos.lat, pos.lng);
  const qs = new URLSearchParams({ pageNo: 1, numOfRows: 60, dataType: 'JSON', base_date: base.date, base_time: baseTime, nx, ny });
  const { data } = await fetchJsonAt(`${BASE}?serviceKey=${serviceKey(raw)}&${qs}`);
  const items = data.response?.body?.items?.item ?? [];
  if (!items.length) return null;
  // 출발 시각이 속한 정시 예보, 없으면 가장 가까운 첫 예보
  const want = kstParts(Math.max(whenMs, now));
  const slot = `${want.date}${want.hm.slice(0, 2)}00`;
  const times = [...new Set(items.map((i) => i.fcstDate + i.fcstTime))].sort();
  const pick = times.includes(slot) ? slot : times[0];
  const v = Object.fromEntries(items.filter((i) => i.fcstDate + i.fcstTime === pick).map((i) => [i.category, i.fcstValue]));
  return {
    precip: PTY[Number(v.PTY)] ?? null,
    rainMm: v.RN1 && v.RN1 !== '강수없음' ? v.RN1 : null,
    tempC: v.T1H != null ? Number(v.T1H) : null,
    at: `${base.date.slice(4, 6)}/${base.date.slice(6)} ${baseTime.slice(0, 2)}:${baseTime.slice(2)} 발표`,
    forTime: `${pick.slice(8, 10)}:${pick.slice(10)}`,
  };
}
