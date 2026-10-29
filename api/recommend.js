// GET /api/recommend — 경로 추천
//   home=화곡                 집 근처 역 이름
//   homeLat, homeLng, homeName  상세주소로 등록한 집 좌표 (home 대신)
//   direction=home|school     하교(기본) / 등교
//   lat, lng                  하교 출발 위치 (없으면 정문)
//   at=<epoch ms>             하교: 이 시각에 출발 (수업 끝나는 시각 등)
//   arriveBy=<epoch ms>       등교: 이 시각까지 도착 (첫 수업 시작)
//   room=미래관6층11호실      등교: 첫 수업 강의실 (정문 → 건물 도보 계산)
//   mode=fast|comfort
//   walkFactor=1.2            내 걸음 속도 배율 (기기에서 잰 값, 0.5~2)
import { handle, HttpError } from './_lib.js';
import { recommend, MAIN_GATE } from './_engine.js';

export const GET = handle(async (url) => recommendFromQuery(url.searchParams));

// 쿼리 → 추천. 예약 알림(/api/push-send)도 발송 시각에 같은 조건으로 다시 계산할 때 사용
export function recommendFromQuery(q) {
  const homeLat = Number(q.get('homeLat'));
  const homeLng = Number(q.get('homeLng'));
  const home = homeLat && homeLng
    ? { lat: homeLat, lng: homeLng, name: (q.get('homeName') || '집').slice(0, 40) }
    : q.get('home');
  if (!home) throw new HttpError(400, 'home(집 근처 역 이름) 또는 homeLat·homeLng가 필요해요');
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
    room: (q.get('room') || '').slice(0, 40) || undefined,
    walkFactor: Math.min(2, Math.max(0.5, Number(q.get('walkFactor')) || 1)),
  });
}
