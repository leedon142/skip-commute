// Gemini를 쓰는 두 가지
// 1) AI 경로 선택: 엔진이 실제 데이터로 계산한 후보 중에서 '지금 이 사람에게 맞는 길' 하나를 고르고 이유를 말함
//    AI는 후보 안에서만 고름 (버스·시간을 지어낼 수 없음). 가장 빠른 길보다 PICK_SLACK_MIN 넘게 늦거나 운행 끝난 길은 못 고름
// 2) 상황 제보 해석: 학우가 쓰거나 말한 제보(사고·정체·통제·날씨)를 정해진 분류로 정리
// 실패·한도 초과면 오류 → 화면은 AI 없이 동작 (경로는 엔진 순위 그대로)
import { HttpError, requireEnv } from './_lib.js';
import { sharedStore } from './_store.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
const PICK_SLACK_MIN = 5;
// 무료 요금제 한도를 넘지 않게 하루 호출 상한 (한국 날짜 기준)
const DAILY_LIMIT = Number(process.env.GEMINI_DAILY_LIMIT) || 300;
const MAX_ROUTES = 8;
export const SITUATION_TYPES = ['사고', '정체', '통제', '공사', '비', '눈', '강풍', '기타'];
export const SITUATION_AFFECTS = ['버스', '지하철', '도보', '전체'];

const counter = sharedStore('gemini');

async function countCall() {
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const used = (await counter.get(day).catch(() => 0)) ?? 0;
  if (used >= DAILY_LIMIT) throw new HttpError(429, `AI 하루 사용량(${DAILY_LIMIT}회)을 다 썼어요`);
  await counter.set(day, used + 1, { ttl: 2 * 86400, name: 'gemini-count' }).catch(() => {});
}

// system·parts·schema로 한 번 묻고 JSON 결과를 돌려줌. 무료 요금제는 가끔 붐비거나(503) 늦어서 다른 가벼운 모델로 한 번만 다시
async function ask(system, parts, schema, timeoutMs = 6_000) {
  const call = async (model) => {
    await countCall();
    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': requireEnv('GEMINI_API_KEY') },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema },
      }),
    });
  };
  let model = MODEL;
  let res = await call(model).catch((e) => { if (e instanceof HttpError) throw e; return null; });
  if (!res || res.status === 503 || res.status === 429) {
    model = FALLBACK_MODEL;
    res = await call(model);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `AI 응답 오류 (${res.status}${data.error?.status ? ` ${data.error.status}` : ''})`);
  try {
    return { out: JSON.parse(data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ?? ''), model };
  } catch {
    throw new HttpError(502, 'AI 응답을 읽지 못했어요');
  }
}

const str = (v, n = 30) => String(v ?? '').slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// 화면이 보낸 경로 → AI에게 보여줄 짧은 설명 (필요한 값만, 길이 제한)
function describe(r, i) {
  const legs = (Array.isArray(r.legs) ? r.legs : []).slice(0, 8);
  const rides = legs.filter((l) => l.type !== 'walk');
  const walkMin = legs.filter((l) => l.type === 'walk').reduce((s, l) => s + (num(l.minutes) ?? 0), 0);
  const first = rides[0];
  return {
    번호: i,
    소요분: Math.round((num(r.totalSec) ?? 0) / 60),
    도착: str(r.arriveAt, 25),
    경로: rides.map((l) => `${l.type === 'bus' ? `${str(l.route, 10)}번 버스` : str(l.line, 15)}(${str(l.from)}→${str(l.to)}, ${num(l.rideMin) ?? '?'}분)`).join(' → '),
    환승: Math.max(0, rides.length - 1),
    걷는분: walkMin,
    서서가는분: num(r.standingMin) ?? 0,
    첫차대기분: first?.waitSec != null ? Math.round(num(first.waitSec) / 60) : null,
    못탈확률: first?.missProb != null ? Math.round(num(first.missProb) * 100) + '%' : null,
    학우줄제보: first?.report ? str(first.report.label ?? first.report, 10) : null,
    태그: (Array.isArray(r.tags) ? r.tags : []).slice(0, 6).map((t) => str(t, 20)),
  };
}

const PICK_SYSTEM = [
  '너는 국민대 학생의 통학길(하교 또는 등교)을 골라 주는 통학 도우미야.',
  '후보 경로는 실시간 데이터로 계산된 것이고, 너는 그중 하나만 고른다. 후보에 없는 버스·시간·정보를 지어내지 마.',
  '반드시 고를수있는번호 중에서 골라. 빠르기만 보지 말고 날씨(비·눈이면 덜 걷기), 못 탈 확률, 학우 줄 제보, 근처 학우 상황 제보(사고·정체·통제 등), 환승, 서서 가는 시간, 정체·막차 태그, 사용자설정을 함께 따져.',
  '가장 빠른 길(소요분이 가장 작은 것)이 아닌 걸 고르면 무엇을 얻는 대신 몇 분 늦는지 말해.',
  '상황 제보가 모든 후보에 똑같이 걸리면(예: 후보가 전부 같은 정류장에서 버스로 출발) 피할 길이 없다는 것과 조심할 점만 말하고, 그 길이 덜 막힌다고 지어내지 마. 앞뒤가 맞게 말해.',
  'reason은 이어폰으로 읽어 줄 한국어 1~2문장, 70자 안팎, 해요체. 후보에 있는 숫자와 이름만 쓰고, 후보 번호(0번, 1번 같은 말)나 "설정에 따라" 같은 말은 쓰지 마. 버스 번호·노선 이름으로 말해.',
].join('\n');

// routes: 엔진 결과(화면에서 받은 것), weather: 엔진 날씨, mode: fast|comfort, situations: 근처 학우 상황 제보
async function pickRoute({ routes, weather, mode, situations = [] }) {
  if (!Array.isArray(routes) || !routes.length) throw new HttpError(400, 'routes가 필요해요');
  const list = routes.slice(0, MAX_ROUTES);
  const fastest = Math.min(...list.filter((r) => !r.unavailable).map((r) => num(r.totalSec) ?? Infinity));
  // 고를 수 있는 후보: 운행 중 + 가장 빠른 길보다 PICK_SLACK_MIN분 안
  const allowed = list.map((r, i) => i).filter((i) => !list[i].unavailable && num(list[i].totalSec) - fastest <= PICK_SLACK_MIN * 60);
  if (allowed.length < 2) return { pick: allowed[0] ?? 0, reason: null, ai: false };

  const situation = {
    날씨: weather ? { 강수: weather.precip || '없음', 기온: weather.tempC ?? null, 주의: (weather.advice ?? []).slice(0, 3) } : '정보 없음',
    사용자설정: mode === 'comfort' ? '편한 길 선호 (앉아서, 환승 적게)' : '빠른 길 선호',
    근처학우상황제보: situations.length ? situations.map((s) => `${s.type}(${s.affects}) ${s.summary} · ${s.agoMin}분 전`) : '없음',
    고를수있는번호: allowed,
    후보: list.map(describe),
  };
  const { out, model } = await ask(PICK_SYSTEM, [{ text: JSON.stringify(situation) }],
    { type: 'OBJECT', properties: { pick: { type: 'INTEGER' }, reason: { type: 'STRING' } }, required: ['pick', 'reason'] });
  // 범위 밖을 고르면 엔진 1등으로
  if (!allowed.includes(out.pick)) return { pick: allowed[0], reason: null, ai: false };
  return { pick: out.pick, reason: str(out.reason, 160) || null, ai: true, model };
}

// 추천 결과에 AI 판단을 입힘: AI가 고른 경로를 맨 앞으로 올리고 route.ai = { reason }.
// 추천이 AI 때문에 늦어지지 않게 PICK_BUDGET_MS 안에 답이 없거나 실패하면 엔진 순위 그대로 (data.ai = null)
const PICK_BUDGET_MS = 5_000;
export async function withAiPick(data, situations = []) {
  data.ai = null;
  if (!process.env.GEMINI_API_KEY || !data.routes?.length) return data;
  try {
    const out = await Promise.race([
      pickRoute({ routes: data.routes, weather: data.weather, mode: data.mode, situations }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('AI 응답이 늦어요')), PICK_BUDGET_MS)),
    ]);
    if (!out.ai) return data;
    const [picked] = data.routes.splice(out.pick, 1);
    picked.ai = { reason: out.reason, engineRank: out.pick + 1 };
    data.routes.unshift(picked);
    data.ai = { model: out.model, situations: situations.length };
  } catch (e) {
    data.aiError = e.message;
  }
  return data;
}

const REPORT_SYSTEM = [
  '국민대 학생이 통학길에서 보낸 상황 제보(글 또는 음성)를 정리해.',
  `통학(버스·지하철·걷는 길·셔틀)에 영향을 주는 사고·정체·통제·공사·날씨 이야기면 relevant=true. 장난, 욕설, 광고, 상관없는 말, 알아들을 수 없는 소리는 relevant=false.`,
  `type은 ${SITUATION_TYPES.join(', ')} 중 하나, affects는 ${SITUATION_AFFECTS.join(', ')} 중 하나.`,
  'summary는 다른 학생에게 보여 줄 짧은 한국어 명사형 한 줄(25자 안, 예: "정릉 사거리 사고로 버스 정체"), 제보에 있는 내용만. 이름·전화번호 같은 개인정보는 빼.',
  '음성이면 heard에 들은 말을 그대로 적어. 글이면 heard는 빈 문자열.',
].join('\n');

// 학우 상황 제보 해석: { text } 또는 { audio: base64, mime } → { relevant, type, affects, summary, heard }
export async function parseSituation({ text, audio, mime }) {
  const parts = audio
    ? [{ inlineData: { mimeType: mime, data: audio } }, { text: '위 음성 제보를 정리해.' }]
    : [{ text: str(text, 300) }];
  const { out } = await ask(REPORT_SYSTEM, parts, {
    type: 'OBJECT',
    properties: {
      relevant: { type: 'BOOLEAN' },
      type: { type: 'STRING', enum: SITUATION_TYPES },
      affects: { type: 'STRING', enum: SITUATION_AFFECTS },
      summary: { type: 'STRING' },
      heard: { type: 'STRING' },
    },
    required: ['relevant', 'type', 'affects', 'summary', 'heard'],
  }, audio ? 12_000 : 6_000);
  return {
    relevant: out.relevant === true && SITUATION_TYPES.includes(out.type) && SITUATION_AFFECTS.includes(out.affects),
    type: out.type, affects: out.affects, summary: str(out.summary, 40), heard: str(out.heard, 200),
  };
}
