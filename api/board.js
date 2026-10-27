// GET /api/board — data/places.json에 등록된 학교 주변 정류장·역을 한 번에 조회
import { handle } from './_lib.js';
import { busStop, subwayStation } from './_transit.js';
import places from '../data/places.json' with { type: 'json' };

export const GET = handle(async () => {
  const results = await Promise.allSettled(
    places.places.map((p) => (p.type === 'bus' ? busStop(p.ars) : subwayStation(p.station))),
  );
  return {
    updatedAt: new Date().toISOString(),
    places: places.places.map((p, i) => {
      const r = results[i];
      return r.status === 'fulfilled'
        ? { ...p, ok: true, data: r.value }
        : { ...p, ok: false, error: r.reason.message };
    }),
  };
});
