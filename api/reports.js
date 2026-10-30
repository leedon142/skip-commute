// 정류장 줄 제보
// GET  /api/reports                         → { reports: [{ id, ars, name, level, at }], updatedAt }  최근 2시간
// POST /api/reports { ars, name, level }     level: ok(여유) | mid(보통) | busy(혼잡)  → { report }
import { json } from './_lib.js';
import { listReports, addReport } from './_reports.js';

export async function GET() {
  try {
    return json({ reports: await listReports(), updatedAt: new Date().toISOString() });
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const client = (request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'local').split(',')[0].trim();
    return json({ report: await addReport({ ars: body.ars, name: body.name, level: body.level, client }) });
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
}
