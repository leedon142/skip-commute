// 정류장 줄 제보
// GET  /api/reports                         → { reports: [{ id, ars, name, level, at } | { id, kind: 'weather', ars, name, value, lat, lng, at } | { id, kind: 'situation', type, affects, summary, lat, lng, at }], updatedAt }  최근 2시간
// POST /api/reports { ars, name, level }     level: ok(여유) | mid(보통) | busy(혼잡)  → { report }
// POST /api/reports { kind: 'weather', ars, name, value, lat, lng }   value: clear(안 와요) | rain(비 와요) | snow(눈 와요)  → { report }
// POST /api/reports { kind: 'situation', text | audio(base64 WAV), lat, lng }  사고·정체·날씨 등 자유 제보 → AI가 정리 → { report, heard }
import { json, HttpError } from './_lib.js';
import { listReports, addReport, addSituation, checkSituationCooldown } from './_reports.js';
import { parseSituation } from './_agent.js';

const MAX_AUDIO_B64 = 1_500_000; // 16kHz 모노 WAV 약 45초

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
    if (body.kind === 'situation') return json(await situation(body, client));
    const { ars, name, level, kind, value, lat, lng } = body;
    return json({ report: await addReport({ ars, name, level, kind, value, lat, lng, client }) });
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
}

async function situation({ text, audio, lat, lng }, client) {
  const hasText = typeof text === 'string' && text.trim().length >= 2;
  const hasAudio = typeof audio === 'string' && audio.length > 100;
  if (!hasText && !hasAudio) throw new HttpError(400, '제보 내용(text 또는 audio)이 필요해요');
  if (hasAudio && audio.length > MAX_AUDIO_B64) throw new HttpError(413, '녹음이 너무 길어요 (30초 안으로)');
  if (!Number(lat) || !Number(lng)) throw new HttpError(400, '상황 제보는 위치(lat, lng)가 필요해요');
  await checkSituationCooldown(client);
  const parsed = await parseSituation(hasAudio ? { audio, mime: 'audio/wav' } : { text: text.trim() });
  if (!parsed.relevant) throw new HttpError(422, parsed.heard ? `통학 상황 제보로 알아듣지 못했어요 (들은 말: ${parsed.heard})` : '통학 상황 제보로 알아듣지 못했어요');
  const report = await addSituation({ ...parsed, lat, lng, client });
  return { report, heard: parsed.heard || null };
}
