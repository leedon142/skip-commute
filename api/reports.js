// 정류장 줄 제보
// GET  /api/reports                         → { reports: [{ id, ars, name, level, at } | { id, kind: 'weather', ars, name, value, lat, lng, at }], updatedAt }  최근 2시간
// POST /api/reports { ars, name, level }     level: ok(여유) | mid(보통) | busy(혼잡)  → { report }
// POST /api/reports { kind: 'weather', ars, name, value, lat, lng }   value: clear(안 와요) | rain(비 와요) | snow(눈 와요)  → { report }
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
    const { ars, name, level, kind, value, lat, lng } = body;
    return json({ report: await addReport({ ars, name, level, kind, value, lat, lng, client }) });
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
}
