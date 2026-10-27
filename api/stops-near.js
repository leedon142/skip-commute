// GET /api/stops-near?lat=37.61&lng=126.99&radius=500 — 주변 버스 정류장 (ARS 번호 찾기용)
import { handle, HttpError } from './_lib.js';
import { busStopsNear } from './_transit.js';

export const GET = handle(async (url) => {
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  const radius = Math.min(Number(url.searchParams.get('radius')) || 500, 1500);
  if (!lat || !lng) throw new HttpError(400, 'lat, lng가 필요해요');
  return busStopsNear(lat, lng, radius);
});
