// Gemini를 쓰는 두 가지
// 1) AI 경로 판단 (에이전트): 엔진이 실제 데이터로 계산한 후보를 받고, 날씨·학우 제보·실시간 도착·엔진 상세·재검색 도구를 스스로 골라 확인한 뒤 하나를 고르고 이유를 말함
//    AI는 후보 안에서만 고름 (버스·시간을 지어낼 수 없음). 가장 빠른 길보다 PICK_SLACK_MIN 넘게 늦거나 운행 끝난 길은 못 고름
// 2) 제보 해석: 학우가 쓰거나 말한 제보를 정류장(줄·인원·만차 통과)/도로/날씨로 정리
// 실패·한도 초과면 오류 → 화면은 AI 없이 동작 (경로는 엔진 순위 그대로)
import { HttpError, requireEnv } from './_lib.js';
import { sharedStore } from './_store.js';
import { summarize, situationsNear } from './_reports.js';
import { busStop } from './_transit.js';

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

// ---------------- AI 경로 판단 (도구를 쓰는 에이전트) ----------------
// 엔진이 실시간 데이터로 계산한 후보를 받고, Gemini가 필요한 도구(날씨·제보·실시간 도착·엔진 상세·다른 시각 재검색)를
// 스스로 골라 불러 확인한 뒤 choose_route로 하나를 고름. 도구 호출은 MAX_TOOL_CALLS번, 재검색은 1번까지
const MAX_TURNS = 4;
const MAX_TOOL_CALLS = 4;

const PICK_SYSTEM = [
  '너는 국민대 학생의 통학길(하교 또는 등교)을 골라 주는 통학 에이전트야.',
  '후보 경로는 엔진이 실시간 데이터로 계산한 것이다. 날씨·학우 제보·사고 같은 현장 상황은 처음엔 모르니, 판단에 필요한 것만 도구로 확인해.',
  '예: 비 오면 덜 걷는 길이 낫다 → get_weather. 첫 버스 정류장 줄·만차 제보 → get_reports(정류장번호). 곧 올 버스가 혼잡한지 → get_arrivals. 못 탈 확률 근거 → estimate_route. 지금 후보가 다 나쁘면 → search_routes(몇 분 뒤 출발, 하교만).',
  '필요한 도구는 한 번에 같이 불러(한 응답에 여러 개). 확인은 많아야 두 번에 끝내고, 같은 도구를 같은 값으로 두 번 부르지 마. 확인이 끝나면 반드시 choose_route를 불러 끝내.',
  'choose_route의 pick은 고를수있는번호 중 하나. 후보에 없는 버스·시간·정보를 지어내지 마. 빠르기만 보지 말고 날씨, 못 탈 확률, 학우 제보, 사고, 환승, 서서 가는 시간, 사용자설정을 함께 따져.',
  '가장 빠른 길이 아닌 걸 고르면 무엇을 얻는 대신 몇 분 늦는지 말해. 상황이 모든 후보에 똑같이 걸리면 피할 길이 없다는 것과 조심할 점만 말해.',
  'reason은 이어폰으로 읽어 줄 한국어 1~2문장, 80자 안팎, 해요체. 확인한 사실과 후보의 숫자·이름만 쓰고, 후보 번호(0번, 1번)는 말하지 말고 버스 번호·노선 이름으로 말해.',
].join('\n');

const TOOLS = [{
  functionDeclarations: [
    { name: 'get_weather', description: '출발 시각의 기상청 날씨(강수, 기온, 폭염·한파 주의)', parameters: { type: 'OBJECT', properties: {} } },
    {
      name: 'get_reports',
      description: '학우 제보. 정류장번호를 주면 그 정류장 줄(여유/보통/혼잡, 대기 인원, 만차로 지나간 노선, 메모), 안 주면 출발지 근처 2km의 사고·정체·날씨 상황 제보',
      parameters: { type: 'OBJECT', properties: { ars: { type: 'STRING', description: '버스 정류장번호 5자리 (없으면 근처 상황 제보)' } } },
    },
    {
      name: 'get_arrivals',
      description: '서울시 버스 실시간 도착: 정류장에 곧 올 두 대의 남은 시간, 혼잡도, 차내 인원, 만차 여부',
      parameters: { type: 'OBJECT', properties: { ars: { type: 'STRING' }, route: { type: 'STRING', description: '버스 번호' } }, required: ['ars', 'route'] },
    },
    {
      name: 'estimate_route',
      description: '엔진 계산 상세: 후보 하나의 구간별 대기·못 탈 확률·추가 대기·앉을 수 있는지와 그 근거',
      parameters: { type: 'OBJECT', properties: { 번호: { type: 'INTEGER' } }, required: ['번호'] },
    },
    {
      name: 'search_routes',
      description: '같은 목적지로 몇 분 뒤 출발하면 어떤지 다시 계산 (한 번만). 결과는 참고용이고 고르는 건 지금 후보 중에서',
      parameters: { type: 'OBJECT', properties: { minutesLater: { type: 'INTEGER', description: '5~60' } }, required: ['minutesLater'] },
    },
    {
      name: 'choose_route',
      description: '최종 선택. 확인이 끝나면 반드시 이걸로 끝냄',
      parameters: { type: 'OBJECT', properties: { pick: { type: 'INTEGER' }, reason: { type: 'STRING' } }, required: ['pick', 'reason'] },
    },
  ],
}];

const rideName = (l) => (l.type === 'bus' ? `${str(l.route, 10)}번` : str(l.line, 15));
const shortRoute = (r) => r.legs.filter((l) => l.type !== 'walk').map(rideName).join(' → ');

// 엔진 경로 → AI에게 보여줄 짧은 설명 (현장 상황은 빼고, 도구로 확인하게 정류장번호를 넣음)
function describe(r, i) {
  const legs = (Array.isArray(r.legs) ? r.legs : []).slice(0, 8);
  const rides = legs.filter((l) => l.type !== 'walk');
  const first = rides[0];
  return {
    번호: i,
    소요분: Math.round((num(r.totalSec) ?? 0) / 60),
    도착: str(r.arriveAt, 25),
    경로: rides.map((l) => `${rideName(l)}(${str(l.from)}${l.ars ? ` 정류장번호 ${l.ars}` : ''} → ${str(l.to)}, ${num(l.rideMin) ?? '?'}분)`).join(' → '),
    환승: Math.max(0, rides.length - 1),
    걷는분: legs.filter((l) => l.type === 'walk').reduce((s, l) => s + (num(l.minutes) ?? 0), 0),
    서서가는분: num(r.standingMin) ?? 0,
    첫차대기분: first?.waitSec != null ? Math.round(num(first.waitSec) / 60) : null,
    못탈확률: first?.missProb != null ? Math.round(num(first.missProb) * 100) + '%' : null,
    태그: (Array.isArray(r.tags) ? r.tags : []).slice(0, 6).map((t) => str(t, 20)),
  };
}

// 도구 실행. ctx: { data, reports, rerun }. 반환 { result, label(화면에 보여줄 '확인한 것') }
async function runTool(name, args, ctx, used) {
  const { data } = ctx;
  switch (name) {
    case 'get_weather': {
      const w = data.weather;
      return { label: '날씨', result: w ? { 강수: w.precip || '없음', 비양: w.rainMm ?? null, 기온: w.tempC ?? null, 주의: w.advice ?? [], 기준: `기상청 ${w.forTime ?? ''}` } : { 오류: '날씨 정보 없음' } };
    }
    case 'get_reports': {
      const ars = /^\d{5}$/.test(String(args.ars ?? '')) ? String(args.ars) : null;
      if (ars) {
        const sum = summarize(ctx.reports, ars);
        const notes = ctx.reports.filter((r) => !r.kind && r.ars === ars && r.note).slice(0, 3).map((r) => r.note);
        const stopName = data.routes.flatMap((r) => r.legs).find((l) => l.ars === ars)?.from ?? ars;
        return {
          label: `${stopName} 줄 제보`,
          result: sum ? { 줄: sum.label, 제보수: sum.total, 몇분전: sum.agoMin, 대기인원: sum.queue?.n ?? null, 만차통과노선: sum.passed, 메모: notes } : { 제보: '최근 15분 제보 없음' },
        };
      }
      const near = data.from?.lat ? situationsNear(ctx.reports, data.from) : [];
      return { label: '근처 사고·날씨 제보', result: near.length ? near.map((s) => `${s.type}(${s.affects}) ${s.summary} · ${s.agoMin}분 전 · ${s.distM}m`) : { 제보: '최근 30분 근처 제보 없음' } };
    }
    case 'get_arrivals': {
      const ars = String(args.ars ?? '');
      if (!/^\d{5}$/.test(ars)) return { label: null, result: { 오류: '정류장번호(5자리)가 필요해요' } };
      const stop = await busStop(ars);
      const rt = stop.routes.find((x) => x.route === String(args.route ?? '').replace(/번$/, ''));
      if (!rt) return { label: null, result: { 오류: `${args.route}번은 이 정류장에 없어요` } };
      return {
        label: `${rt.route}번 실시간 도착`,
        result: rt.arrivals.filter(Boolean).map((a) => ({ 남은분: a.seconds != null ? Math.round(a.seconds / 60) : null, 안내: a.message, 혼잡: a.congestion, 차내인원: a.passengers, 만차: a.full })),
      };
    }
    case 'estimate_route': {
      const r = data.routes[num(args.번호)];
      if (!r) return { label: null, result: { 오류: '없는 번호' } };
      return {
        label: `${shortRoute(r)} 계산 근거`,
        result: r.legs.filter((l) => l.type !== 'walk').map((l) => ({
          구간: `${rideName(l)} ${str(l.from)}→${str(l.to)}`,
          대기분: l.waitSec != null ? Math.round(l.waitSec / 60) : null,
          못탈확률: l.missProb != null ? Math.round(l.missProb * 100) + '%' : null,
          추가대기분: l.extraWaitSec ? Math.round(l.extraWaitSec / 60) : 0,
          앉을수있음: l.seatLikely,
          근거: (l.notes ?? []).slice(0, 4),
        })),
      };
    }
    case 'search_routes': {
      if (!ctx.rerun) return { label: null, result: { 오류: '등교는 다시 검색하지 않아요' } };
      if (used.searched) return { label: null, result: { 오류: '다시 검색은 한 번만 할 수 있어요' } };
      used.searched = true;
      const later = Math.min(60, Math.max(5, num(args.minutesLater) ?? 10));
      const again = await ctx.rerun(later);
      return {
        label: `${later}분 뒤 출발 다시 검색`,
        result: again.routes.filter((r) => !r.unavailable).slice(0, 3).map((r) => ({ 경로: shortRoute(r), 소요분: Math.round(r.totalSec / 60), 도착: r.arriveAt })),
      };
    }
    default:
      return { label: null, result: { 오류: '없는 도구' } };
  }
}

// Gemini 한 번 호출 (도구 포함). 붐비면(503·429·시간 초과) 한 번 더: 첫 호출이면 가벼운 다른 모델로
async function callWithTools(state, contents) {
  const send = async (model) => {
    await countCall();
    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': requireEnv('GEMINI_API_KEY') },
      signal: AbortSignal.timeout(6_000),
      body: JSON.stringify({ systemInstruction: { parts: [{ text: PICK_SYSTEM }] }, contents, tools: state.tools, generationConfig: { temperature: 0.2 } }),
    });
  };
  let res = await send(state.model).catch((e) => { if (e instanceof HttpError) throw e; return null; });
  if (!res || res.status === 503 || res.status === 429) {
    // 첫 호출이면 다른 모델로 바꿔서, 대화 중간이면 같은 모델로 한 번 더 (대화 기록이 모델에 묶여 있음)
    if (state.first) state.model = FALLBACK_MODEL;
    res = await send(state.model);
  }
  state.first = false;
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `AI 응답 오류 (${res.status}${out.error?.status ? ` ${out.error.status}` : ''})`);
  const content = out.candidates?.[0]?.content;
  if (!content?.parts?.length) throw new HttpError(502, 'AI 응답이 비어 있어요');
  return content;
}

// ctx: { data(엔진 결과), reports(최근 제보), rerun(분 → 그만큼 뒤 출발로 엔진 재계산) }
async function pickRoute(ctx) {
  const { data } = ctx;
  const list = data.routes.slice(0, MAX_ROUTES);
  const fastest = Math.min(...list.filter((r) => !r.unavailable).map((r) => num(r.totalSec) ?? Infinity));
  // 고를 수 있는 후보: 운행 중 + 가장 빠른 길보다 PICK_SLACK_MIN분 안
  const allowed = list.map((r, i) => i).filter((i) => !list[i].unavailable && num(list[i].totalSec) - fastest <= PICK_SLACK_MIN * 60);
  if (allowed.length < 2) return { pick: allowed[0] ?? 0, reason: null, ai: false };

  const situation = {
    방향: data.direction === 'school' ? '등교' : '하교',
    사용자설정: data.mode === 'comfort' ? '편한 길 선호 (앉아서, 환승 적게)' : '빠른 길 선호',
    고를수있는번호: allowed,
    후보: list.map(describe),
  };
  const contents = [{ role: 'user', parts: [{ text: JSON.stringify(situation) }] }];
  // 등교는 도착 시각이 정해져 있어 '몇 분 뒤 출발' 재검색이 없음 → 그 도구를 아예 안 보여 줌
  const tools = ctx.rerun ? TOOLS : [{ functionDeclarations: TOOLS[0].functionDeclarations.filter((d) => d.name !== 'search_routes') }];
  const state = { model: MODEL, first: true, tools };
  const used = { searched: false };
  const checked = [];
  let toolCalls = 0;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const content = await callWithTools(state, contents);
    contents.push(content); // 모델 응답 그대로 (Gemini 3의 thoughtSignature 유지)
    const calls = content.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const choose = calls.find((c) => c.name === 'choose_route');
    if (choose) {
      const pick = num(choose.args?.pick);
      if (!allowed.includes(pick)) return { pick: allowed[0], reason: null, ai: false };
      return { pick, reason: str(choose.args?.reason, 160) || null, ai: true, model: state.model, checked };
    }
    if (!calls.length) break; // 도구도 선택도 없이 글만 쓰면 엔진 순위 그대로
    const responses = [];
    for (const call of calls) {
      let out;
      if (toolCalls >= MAX_TOOL_CALLS) out = { result: { 오류: '확인은 여기까지. 이제 choose_route로 골라' }, label: null };
      else {
        toolCalls++;
        out = await runTool(call.name, call.args ?? {}, ctx, used).catch((e) => ({ result: { 오류: e.message }, label: null }));
      }
      if (out.label && !checked.includes(out.label)) checked.push(out.label);
      responses.push({ functionResponse: { name: call.name, response: { result: out.result } } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { pick: allowed[0], reason: null, ai: false };
}

// 추천 결과에 AI 판단을 입힘: AI가 고른 경로를 맨 앞으로 올리고 route.ai = { reason, checked(AI가 확인한 것) }.
// 도구를 몇 번 오가면 몇 초 걸려서, 화면은 엔진 결과를 먼저 보여 주고 이걸 따로 받아 바꿔 그림 (/api/recommend?ai=1)
// PICK_BUDGET_MS 안에 끝나지 않거나 실패하면 엔진 순위 그대로 (data.ai = null)
const PICK_BUDGET_MS = 15_000;
export async function withAiPick(data, { reports = [], rerun } = {}) {
  data.ai = null;
  if (!process.env.GEMINI_API_KEY || !data.routes?.length) return data;
  try {
    const out = await Promise.race([
      pickRoute({ data, reports, rerun }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('AI 응답이 늦어요')), PICK_BUDGET_MS)),
    ]);
    if (!out.ai) return data;
    const [picked] = data.routes.splice(out.pick, 1);
    picked.ai = { reason: out.reason, engineRank: out.pick + 1, checked: out.checked };
    data.routes.unshift(picked);
    data.ai = { model: out.model, checked: out.checked };
  } catch (e) {
    data.aiError = e.message;
  }
  return data;
}

const REPORT_SYSTEM = [
  '국민대 학생이 통학길에서 보낸 제보(글 또는 음성)를 정리해.',
  'category: 버스 정류장·셔틀 줄, 대기 인원, 버스가 만차로 지나감 같은 정류장 이야기면 "정류장". 사고·정체·통제·공사 같은 길 이야기면 "도로". 비·눈·강풍 같은 날씨면 "날씨". 통학과 상관없는 말이면 relevant=false.',
  `type은 ${SITUATION_TYPES.join(', ')} 중 하나, affects는 ${SITUATION_AFFECTS.join(', ')} 중 하나 (정류장 이야기면 type "정체", affects "버스").`,
  '정류장 이야기면: level은 줄이 여유/보통/혼잡 중 ok/mid/busy (모르면 인원으로 판단: 10명 안 ok, 25명 안 mid, 그 이상 busy, 둘 다 모르면 none). queue는 기다리는 사람 수 (말에 없으면 -1, "많다"처럼 숫자가 없으면 -1). route는 말한 버스 번호(없으면 빈 문자열), passed는 그 버스가 만차라 안 태우고 지나갔다는 말이 있으면 true.',
  '정류장 이야기가 아니면 level은 "none", queue -1, route 빈 문자열, passed false.',
  'summary는 다른 학생에게 보여 줄 짧은 한국어 명사형 한 줄(25자 안, 예: "정릉 사거리 사고로 버스 정체", "줄 30명쯤, 7211 만차 통과"), 제보에 있는 내용만. 이름·전화번호 같은 개인정보는 빼.',
  '음성이면 heard에 들은 말을 그대로 적어. 글이면 heard는 빈 문자열.',
].join('\n');

// 학우 제보 해석: { text } 또는 { audio: base64, mime }
//   → { relevant, category: 정류장|도로|날씨, type, affects, summary, heard, level, queue(없으면 null), route, passed }
export async function parseSituation({ text, audio, mime }) {
  const parts = audio
    ? [{ inlineData: { mimeType: mime, data: audio } }, { text: '위 음성 제보를 정리해.' }]
    : [{ text: str(text, 300) }];
  const { out } = await ask(REPORT_SYSTEM, parts, {
    type: 'OBJECT',
    properties: {
      relevant: { type: 'BOOLEAN' },
      category: { type: 'STRING', enum: ['정류장', '도로', '날씨'] },
      type: { type: 'STRING', enum: SITUATION_TYPES },
      affects: { type: 'STRING', enum: SITUATION_AFFECTS },
      level: { type: 'STRING', enum: ['ok', 'mid', 'busy', 'none'] },
      queue: { type: 'INTEGER' },
      route: { type: 'STRING' },
      passed: { type: 'BOOLEAN' },
      summary: { type: 'STRING' },
      heard: { type: 'STRING' },
    },
    required: ['relevant', 'category', 'type', 'affects', 'level', 'queue', 'route', 'passed', 'summary', 'heard'],
  }, audio ? 12_000 : 6_000);
  const queue = Number.isInteger(out.queue) && out.queue >= 0 ? Math.min(out.queue, 300) : null;
  return {
    relevant: out.relevant === true && SITUATION_TYPES.includes(out.type) && SITUATION_AFFECTS.includes(out.affects),
    category: out.category, type: out.type, affects: out.affects, summary: str(out.summary, 40), heard: str(out.heard, 200),
    level: ['ok', 'mid', 'busy'].includes(out.level) ? out.level : queue == null ? 'mid' : queue < 10 ? 'ok' : queue < 25 ? 'mid' : 'busy',
    queue, route: str(out.route, 10).replace(/번$/, ''), passed: out.passed === true,
  };
}
