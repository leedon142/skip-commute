// POST /api/timetable-image  { image: <base64 JPEG/PNG>, mimeType } — 시간표 사진 → 수업 목록 (Gemini 무료 키)
// 사진은 저장하지 않고 바로 Gemini에 넘긴 뒤 결과만 돌려줌. 저장은 사용자가 확인한 뒤 기기(localStorage)에.
import { requireEnv, HttpError, json } from './_lib.js';

const MODEL = 'gemini-3.5-flash';
const MAX_BASE64 = 4_000_000; // Vercel 요청 본문 4.5MB 제한 안쪽

const PROMPT = `대학교 시간표 사진이야. 모든 수업 칸을 빠짐없이 읽어서 목록으로 만들어.
- 한 과목이 여러 요일에 있으면 요일마다 따로 한 줄씩.
- day: 월=1 화=2 수=3 목=4 금=5 토=6
- start, end: 24시간 HH:MM. 칸의 위치와 시간 축 눈금으로 정확히 계산.
- room: 사진에 적힌 강의실 그대로. 없으면 빈 문자열.
- 수업이 아닌 것(학교 로고, 메뉴 등)은 넣지 마.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    classes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          day: { type: 'INTEGER' },
          start: { type: 'STRING' },
          end: { type: 'STRING' },
          name: { type: 'STRING' },
          room: { type: 'STRING' },
        },
        required: ['day', 'start', 'end', 'name', 'room'],
      },
    },
  },
  required: ['classes'],
};

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function POST(request) {
  try {
    const { image, mimeType } = await request.json().catch(() => ({}));
    if (typeof image !== 'string' || !image) throw new HttpError(400, '사진이 없어요');
    if (image.length > MAX_BASE64) throw new HttpError(413, '사진이 너무 커요');
    if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) throw new HttpError(400, 'JPG·PNG 사진만 돼요');

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': requireEnv('GEMINI_API_KEY') },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: image } }, { text: PROMPT }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0, thinkingConfig: { thinkingLevel: 'medium' } },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new HttpError(res.status === 429 ? 429 : 502, res.status === 429
        ? '사진 인식 무료 한도를 잠깐 넘었어요. 1분 뒤에 다시 해 주세요.'
        : `사진 인식 오류: ${data.error?.message || res.status}`);
    }
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '{}';
    const classes = (JSON.parse(text).classes || [])
      .map((c) => ({ day: Number(c.day), start: String(c.start), end: String(c.end), name: String(c.name).trim(), room: String(c.room || '').trim() }))
      .filter((c) => c.day >= 1 && c.day <= 6 && HM.test(c.start) && HM.test(c.end) && c.start < c.end && c.name);
    if (!classes.length) throw new HttpError(422, '사진에서 수업을 찾지 못했어요. 시간표 전체가 보이게 다시 찍어 주세요.');
    return json({ classes });
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
}
