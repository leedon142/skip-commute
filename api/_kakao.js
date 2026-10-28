// Kakao 로컬 API (주소·장소 검색)
import { HttpError, requireEnv } from './_lib.js';

const BASE = 'https://dapi.kakao.com/v2/local/search';

// kind: 'address' | 'keyword', extra: x·y·radius 등 (장소 검색 범위 제한)
export async function kakao(kind, q, extra = {}) {
  const res = await fetch(`${BASE}/${kind}.json?${new URLSearchParams({ query: q, size: '5', ...extra })}`, {
    headers: { Authorization: `KakaoAK ${requireEnv('KAKAO_REST_KEY')}` },
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (!res.ok) throw new HttpError(502, `카카오 주소 검색 오류: ${data.message || res.status}`);
  return data.documents;
}
