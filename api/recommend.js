// GET /api/recommend?home=화곡&lat=..&lng=..&mode=fast|comfort — 하교 경로 추천
import { handle, HttpError } from './_lib.js';
import { recommend, MAIN_GATE } from './_engine.js';

export const GET = handle(async (url) => {
  const home = url.searchParams.get('home');
  if (!home) throw new HttpError(400, 'home(집 근처 역 이름)이 필요해요');
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  const origin = lat && lng ? { lat, lng, source: 'gps' } : { ...MAIN_GATE, source: 'main-gate' };
  const mode = url.searchParams.get('mode') === 'comfort' ? 'comfort' : 'fast';
  return recommend({ origin, home, mode });
});
