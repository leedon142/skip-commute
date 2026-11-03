// 서울시 실시간 돌발정보 (사고·고장·공사·행사) — 열린데이터광장 AccInfo
// 좌표가 GRS80 TM이라 위경도로 바꿔서 내 주변 것만 골라 줌. 응답은 XML만 지원
import { HttpError, requireEnv } from './_lib.js';

const BASE = 'http://openapi.seoul.go.kr:8088';
const CACHE_MS = 3 * 60e3; // 전국 사용자가 같은 목록을 보니 짧게 모아서 한 번만 부름
// 코드 의미는 응답 본문으로 확인한 것만 (A01 사고, A02 고장, A04 공사, A10 행사). 그 밖은 '돌발'
const TYPES = { A01: '사고', A02: '차량 고장', A04: '공사', A10: '행사' };
const URGENT = ['A01', 'A02']; // 사고성은 목록 맨 위

// GRS80 TM (EPSG:5181: 중부원점 38°N 127°E, 동쪽 200000m, 북쪽 500000m) → 위경도. Krüger n-급수 역변환
const D = Math.PI / 180;
const WGS_A = 6378137;
const WGS_F = 1 / 298.257222101;
const n = WGS_F / (2 - WGS_F);
const n2 = n * n, n3 = n2 * n, n4 = n3 * n;
const AA = (WGS_A / (1 + n)) * (1 + n2 / 4 + n4 / 64);
const ALPHA = [n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180, 13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440, 61 * n3 / 240 - 103 * n4 / 140, 49561 * n4 / 161280];
const BETA = [n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360, n2 / 48 + n3 / 15 - 437 * n4 / 1440, 17 * n3 / 480 - 37 * n4 / 840, 4397 * n4 / 161280];
const DELTA = [2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45, 7 * n2 / 3 - 8 * n3 / 5 - 227 * n4 / 45, 56 * n3 / 15 - 136 * n4 / 35, 4279 * n4 / 630];
const LAT0 = 38 * D;
const LON0 = 127 * D;
// 원점 위도의 등각위도 χ0 → 원점까지의 자오선 거리에 해당하는 ξ0
const E = Math.sqrt(WGS_F * (2 - WGS_F));
const CHI0 = Math.atan(Math.sinh(Math.asinh(Math.tan(LAT0)) - E * Math.atanh(E * Math.sin(LAT0))));
const XI0 = CHI0 + ALPHA.reduce((s, a, j) => s + a * Math.sin(2 * (j + 1) * CHI0), 0);

export function tmToLatLng(x, y) {
  const xi = XI0 + (y - 500000) / AA;
  const eta = (x - 200000) / AA;
  let xi2 = xi, eta2 = eta;
  BETA.forEach((b, j) => {
    const k = 2 * (j + 1);
    xi2 -= b * Math.sin(k * xi) * Math.cosh(k * eta);
    eta2 -= b * Math.cos(k * xi) * Math.sinh(k * eta);
  });
  const chi = Math.asin(Math.sin(xi2) / Math.cosh(eta2));
  const lat = chi + DELTA.reduce((s, d, j) => s + d * Math.sin(2 * (j + 1) * chi), 0);
  const lng = LON0 + Math.atan2(Math.sinh(eta2), Math.cos(xi2));
  return { lat: lat / D, lng: lng / D };
}

function distM(a, b) {
  const dLat = (b.lat - a.lat) * D;
  const dLng = (b.lng - a.lng) * D;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D) * Math.cos(b.lat * D) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#13;': '\n', '&#10;': '\n' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|#13|#10);/g, (m) => ENTITIES[m]);

// 'YYYYMMDD' + 'HHmm' 또는 'HHmmss' (한국 시각) → ms
function kst(date, time) {
  const t = String(time).padStart(4, '0').padEnd(6, '0');
  const ms = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}+09:00`);
  return Number.isFinite(ms) ? ms : null;
}

export function parseIncidents(xml) {
  return [...xml.matchAll(/<row>([\s\S]*?)<\/row>/g)].flatMap((m) => {
    const f = Object.fromEntries([...m[1].matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)].map((x) => [x[1], decode(x[2])]));
    const x = Number(f.grs80tm_x), y = Number(f.grs80tm_y);
    if (!f.acc_id || !Number.isFinite(x) || !Number.isFinite(y)) return [];
    const start = kst(f.occr_date, f.occr_time);
    const end = kst(f.exp_clr_date, f.exp_clr_time);
    // 첫 줄만 (공사는 일시·장소·통제가 줄마다 이어져 길어서 둘째 줄부터는 뺌). 앞의 '[사고]' 같은 말머리는 화면에 종류 표시가 따로 있어 뗌
    const text = (f.acc_info.split('\n').map((s) => s.trim()).find(Boolean) ?? '').replace(/^\[[^\]]{1,6}\]\s*/, '');
    return [{ id: f.acc_id, type: f.acc_type, label: TYPES[f.acc_type] ?? '돌발', text, start, end, ...tmToLatLng(x, y) }];
  });
}

let cached = null;
async function allIncidents(now) {
  if (cached && now - cached.at < CACHE_MS) return cached.promise;
  const key = requireEnv('SEOUL_OPENDATA_KEY');
  const entry = { at: now };
  entry.promise = (async () => {
    const res = await fetch(`${BASE}/${key}/xml/AccInfo/1/500/`, { signal: AbortSignal.timeout(10_000) });
    const xml = await res.text();
    const code = xml.match(/<CODE>([^<]+)<\/CODE>/)?.[1];
    // 목록이 비어 있으면 INFO-200(해당하는 데이터가 없음)이 옴
    if (code && code !== 'INFO-000' && code !== 'INFO-200') throw new HttpError(502, `서울시 돌발정보 오류 (${code})`);
    return parseIncidents(xml);
  })();
  entry.promise.catch(() => { if (cached === entry) cached = null; });
  cached = entry;
  return entry.promise;
}

// 지금 진행 중인 돌발정보 전부 (서울시 전체)
export async function activeIncidents(now = Date.now()) {
  const all = await allIncidents(now);
  return all.filter((i) => (i.start == null || i.start <= now + 5 * 60e3) && (i.end == null || i.end >= now));
}

const byUrgency = (a, b) => (URGENT.includes(b.type) - URGENT.includes(a.type)) || a.distM - b.distM;
const publicShape = ({ id, type, label, text, end, distM: d }) => ({ id, type, label, text, until: end, distM: d });

// 지금 진행 중인 것 중 pos에서 radiusM 안: 사고성 먼저, 그다음 가까운 순
export async function nearbyIncidents(pos, radiusM = 1500, now = Date.now()) {
  return (await activeIncidents(now))
    .map((i) => ({ ...i, distM: Math.round(distM(pos, i)) }))
    .filter((i) => i.distM <= radiusM)
    .sort(byUrgency)
    .map(publicShape);
}

// 점 p에서 선분 a-b까지 거리(m). 몇 km 안이라 위도 1°=111.2km, 경도는 cos(위도)로 줄여서 평면으로 계산
function segDistM(p, a, b) {
  const kx = 111200 * Math.cos(p.lat * D);
  const ky = 111200;
  const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// 버스가 지나는 정류장들(순서대로)의 길 위에서 radiusM 안에 있는 돌발정보: 사고성 먼저. 정류장 사이는 직선으로 이음
export function incidentsAlong(stops, incidents, radiusM = 300) {
  if (!stops?.length) return [];
  const line = stops.length > 1 ? stops : [stops[0], stops[0]];
  return incidents
    .map((i) => ({ ...i, distM: Math.round(Math.min(...line.slice(1).map((s, k) => segDistM(i, line[k], s)))) }))
    .filter((i) => i.distM <= radiusM)
    .sort(byUrgency)
    .map(publicShape);
}
