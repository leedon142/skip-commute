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
// 엔진이 후보를 계산한 뒤 AI 에이전트(Gemini)가 날씨·제보·실시간 도착 등을 도구로 확인하고 하나를 골라 맨 앞으로 올리고 이유를 붙임 (route.ai). 실패하면 엔진 순위 그대로
import { handle, HttpError } from './_lib.js';
import { recommend, MAIN_GATE } from './_engine.js';
import { withAiPick } from './_agent.js';
import { listReports } from './_reports.js';

//   ai=0                      AI 판단 없이 엔진 결과만 (화면이 먼저 빨리 그릴 때. AI 판단은 몇 초 걸려서 ai=1로 따로 받음)
export const GET = handle(async (url) => recommendFromQuery(url.searchParams));

// 쿼리 → 추천(+AI 판단). 예약 알림(/api/push-send)도 발송 시각에 같은 조건으로 다시 계산할 때 사용
export async function recommendFromQuery(q) {
  const data = await engineFromQuery(q);
  if (q.get('ai') === '0') return { ...data, ai: null };
  const reports = await listReports().catch(() => []);
  // AI의 '몇 분 뒤 출발하면?' 재검색 (하교만, 같은 출발·도착이라 ODsay는 저장본을 씀)
  const rerun = data.direction === 'school' ? undefined : (minutes) => {
    const later = new URLSearchParams(q);
    later.set('at', String((Number(q.get('at')) || Date.now()) + minutes * 60e3));
    return engineFromQuery(later);
  };
  return withAiPick(data, { reports, rerun });
}

function engineFromQuery(q) {
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
