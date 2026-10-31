// 웹 푸시 알림
// GET  /api/push                          → { publicKey, canSchedule }  구독할 때 쓰는 공개키, 예약 가능 여부
// POST /api/push { action: 'test', subscription }             → 지금 바로 테스트 알림
// POST /api/push { action: 'schedule', subscription, kind, at, query, plannedLeaveBy?, cancel? }
//        kind: 'dismissal'(하교 브리핑) | 'morning'(등교 알람), at: 보낼 시각(epoch ms)
//        query: /api/recommend 쿼리 문자열. 보낼 때 이 조건으로 실시간 재계산 → { messageId }
// POST /api/push { action: 'cancel', messageId }              → 예약 취소
import { json, HttpError } from './_lib.js';
import { publicKey, canSchedule, checkSubscription, sendPush, schedule, cancel } from './_push.js';

export async function GET() {
  try {
    return json({ publicKey: publicKey(), canSchedule: canSchedule() });
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
}

export async function POST(request) {
  try {
    const origin = new URL(request.url).origin;
    const body = await request.json().catch(() => ({}));
    if (body.action === 'test') {
      const r = await sendPush(checkSubscription(body.subscription), {
        title: '알림이 켜졌어요',
        body: '수업 끝나기 전 하교 브리핑과 등교 알람을 이렇게 보내드려요. 눌러서 하교 경로 보기',
        url: '/?app=1&tab=3&mode=dismissal&from=push',
        tag: 'skip-test',
      }, origin);
      if (r.gone) throw new HttpError(410, '알림 구독이 만료됐어요. 알림을 다시 켜 주세요.');
      return json({ sent: true });
    }
    if (body.action === 'schedule') {
      if (!canSchedule()) throw new HttpError(503, '예약 알림 설정(QSTASH_TOKEN)이 없어요. 테스트 알림만 돼요.');
      const subscription = checkSubscription(body.subscription);
      const kind = body.kind === 'morning' ? 'morning' : 'dismissal';
      const at = Number(body.at);
      if (!(at > Date.now() - 60_000)) throw new HttpError(400, '보낼 시각이 지났어요');
      const query = String(body.query || '').slice(0, 1500);
      if (!new URLSearchParams(query).get('home') && !new URLSearchParams(query).get('homeLat')) {
        throw new HttpError(400, '집이 등록돼야 알림을 예약할 수 있어요');
      }
      await cancel(body.cancel);
      const messageId = await schedule(`${origin}/api/push-send`, {
        subscription, kind, at, query,
        plannedLeaveBy: Number(body.plannedLeaveBy) || null,
      }, at);
      return json({ messageId, at });
    }
    if (body.action === 'cancel') {
      await cancel(body.messageId);
      return json({ cancelled: true });
    }
    throw new HttpError(400, 'action은 test, schedule, cancel 중 하나예요');
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
}
