// 국민대 셔틀
// GET  /api/shuttle                                   → 시간표 + 오늘 편별 탑승 기록 + 최근 실제 소요 시간
// POST /api/shuttle { action: 'board', line, from, dep } → 탔어요 { record }   line: morning|day|night, from: gireum|kookmin|yongduri, dep: 'HH:MM'
// POST /api/shuttle { action: 'alight', id }             → 내렸어요 { record (rideMin 포함) }
import { json, HttpError } from './_lib.js';
import { shuttleStatus, board, alight } from './_shuttle.js';

export async function GET() {
  try {
    return json(await shuttleStatus());
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const client = (request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'local').split(',')[0].trim();
    if (body.action === 'board') return json({ record: await board({ line: body.line, from: body.from, dep: String(body.dep || ''), client }) });
    if (body.action === 'alight') return json({ record: await alight({ id: String(body.id || '') }) });
    throw new HttpError(400, 'action은 board, alight 중 하나예요');
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
}
