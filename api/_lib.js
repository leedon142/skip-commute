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
  return (await fetchJsonAt(url)).data;
}

// { data, at }: at = 실제로 받아온 시각 (캐시에서 꺼내도 원래 시각). 같은 주소를 동시에 부르면 한 번만 호출
// 저장해 둔 응답을 버림 (한도 초과 같은 일시 오류를 20초 동안 계속 보여주지 않게)
export function forgetCached(url) {
  cache.delete(url);
}

export function fetchJsonAt(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const entry = { at: Date.now() };
  entry.promise = (async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    try {
      return { data: JSON.parse(text), at: entry.at };
    } catch {
      throw new HttpError(502, `공공 API 응답이 JSON이 아니에요: ${text.slice(0, 200)}`);
    }
  })();
  entry.promise.catch(() => cache.delete(url));
  cache.set(url, entry);
  return entry.promise;
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
