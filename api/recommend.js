// GET /api/recommend — 경로 추천
//   home=화곡                 집 근처 역 이름 (필수)
//   direction=home|school     하교(기본) / 등교
//   lat, lng                  하교 출발 위치 (없으면 정문)
//   at=<epoch ms>             하교: 이 시각에 출발 (수업 끝나는 시각 등)
//   arriveBy=<epoch ms>       등교: 이 시각까지 도착 (첫 수업 시작)
//   mode=fast|comfort
import { handle, HttpError } from './_lib.js';
import { recommend, MAIN_GATE } from './_engine.js';

export const GET = handle(async (url) => {
  const q = url.searchParams;
  const home = q.get('home');
  if (!home) throw new HttpError(400, 'home(집 근처 역 이름)이 필요해요');
  const lat = Number(q.get('lat'));
  const lng = Number(q.get('lng'));
  const origin = lat && lng ? { lat, lng, source: 'gps' } : { ...MAIN_GATE, source: 'main-gate' };
  return recommend({
    origin,
    home,
    direction: q.get('direction') === 'school' ? 'school' : 'home',
    mode: q.get('mode') === 'comfort' ? 'comfort' : 'fast',
    departAt: Number(q.get('at')) || undefined,
    arriveBy: Number(q.get('arriveBy')) || undefined,
  });
});
