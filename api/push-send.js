// POST /api/push-send — QStash가 예약 시각에 부름. 실시간으로 다시 계산해서 알림을 보냄
// 계산이 실패해도 알림은 보냄 (눌러서 앱에서 다시 계산)
import { json } from './_lib.js';
import { verifyQStash, sendPush } from './_push.js';
import { recommendFromQuery } from './recommend.js';

const hhmm = (iso) => new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Seoul',
}).format(new Date(iso));
const rideName = (l) => (l.type === 'bus' ? `${l.route}번` : String(l.line || '').replace('수도권 ', ''));

export async function buildMessage(job) {
  const morning = job.kind === 'morning';
  const url = `/?app=1&tab=3&mode=${morning ? 'morning' : 'dismissal'}&from=push`;
  const tag = `skip-${job.kind}`;
  try {
    const data = await recommendFromQuery(new URLSearchParams(job.query));
    const top = data.routes.find((r) => !r.unavailable) ?? data.routes[0];
    if (!top) throw new Error('경로 없음');
    const first = top.legs.find((l) => l.type !== 'walk');
    const total = Math.round(top.totalSec / 60);
    if (morning) {
      // 예약할 때 계산한 출발 시각보다 당겨졌으면 알려줌 (비·정체 등)
      const diffMin = job.plannedLeaveBy ? Math.round((job.plannedLeaveBy - Date.parse(top.leaveBy)) / 60000) : 0;
      return {
        title: `${hhmm(top.leaveBy)}에 출발하세요${diffMin >= 3 ? ` · ${diffMin}분 당겨짐` : ''}`,
        body: `${first ? `${first.from} ${rideName(first)} ${hhmm(first.departAt)} 탑승 → ` : ''}${hhmm(top.arriveAt)} ${data.to?.name ?? '학교'} 도착 (총 ${total}분).`
          + (data.weather?.precip ? ` ${data.weather.precip} 예보 반영.` : ''),
        url, tag,
      };
    }
    const risky = top.legs.find((l) => l.type === 'bus' && (l.full || l.missProb >= 0.4));
    return {
      title: `수업 끝 · ${first ? `${first.from} ${rideName(first)} ${hhmm(first.departAt)}` : '하교 경로'} 추천`,
      body: `${hhmm(top.arriveAt)} ${data.destination?.name ?? '집'} 도착 (총 ${total}분).`
        + (risky ? ` ${risky.route}번은 ${risky.full ? '만차' : '못 탈 수 있어요'}.` : '')
        + ' 눌러서 다른 경로 보기',
      url, tag,
    };
  } catch {
    return morning
      ? { title: '등교 준비할 시간이에요', body: '눌러서 지금 기준 출발 시각과 경로를 확인하세요.', url, tag }
      : { title: '곧 수업이 끝나요', body: '눌러서 실시간 하교 경로를 확인하세요.', url, tag };
  }
}

export async function POST(request) {
  const raw = await request.text();
  try {
    verifyQStash(request.headers.get('upstash-signature'), raw);
  } catch (e) {
    return json({ error: e.message }, e.status || 401);
  }
  try {
    const job = JSON.parse(raw);
    const r = await sendPush(job.subscription, await buildMessage(job), new URL(request.url).origin);
    // 구독 만료는 재시도해도 소용없으니 성공으로 응답
    return json(r);
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
}
