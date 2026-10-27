// GET /api/bus?ars=08107 — 정류장 하나의 실시간 도착 정보
import { handle, HttpError } from './_lib.js';
import { busStop } from './_transit.js';

export const GET = handle(async (url) => {
  const ars = url.searchParams.get('ars');
  if (!/^\d{5}$/.test(ars || '')) throw new HttpError(400, 'ars는 5자리 정류장 번호예요');
  return busStop(ars);
});
