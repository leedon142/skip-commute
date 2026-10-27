// GET /api/subway?station=정릉 — 역 하나의 실시간 열차 도착 정보
import { handle, HttpError } from './_lib.js';
import { subwayStation } from './_transit.js';

export const GET = handle(async (url) => {
  const station = url.searchParams.get('station');
  if (!station) throw new HttpError(400, 'station(역 이름)이 필요해요');
  return subwayStation(station);
});
