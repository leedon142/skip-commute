// 공공 API 호출 공통 처리: 키 확인, 짧은 캐시(호출 한도 절약), JSON 응답
const cache = new Map();
const TTL_MS = 20_000;

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new HttpError(503, `${name} 환경변수가 없어요. .env에 키를 넣어 주세요.`);
  return v;
}

// data.go.kr 키는 인코딩/디코딩 두 종류라, 이미 인코딩된 키는 그대로 사용
export function serviceKey(raw) {
  return raw.includes('%') ? raw : encodeURIComponent(raw);
}

export async function fetchJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(502, `공공 API 응답이 JSON이 아니에요: ${text.slice(0, 200)}`);
  }
  cache.set(url, { at: Date.now(), data });
  return data;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function handle(fn) {
  return async (request) => {
    try {
      return json(await fn(new URL(request.url)));
    } catch (e) {
      return json({ error: e.message }, e.status || 500);
    }
  };
}
