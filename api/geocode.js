// GET /api/geocode?q=은평구 통일로 856 — 집 주소·건물·역 이름 → 좌표 후보 (Kakao 로컬 API)
// 주소로 먼저 찾고, 없으면 장소 이름(아파트, 역 등)으로 찾음
import { handle, HttpError, requireEnv } from './_lib.js';

const BASE = 'https://dapi.kakao.com/v2/local/search';

async function kakao(kind, q) {
  const res = await fetch(`${BASE}/${kind}.json?${new URLSearchParams({ query: q, size: '5' })}`, {
    headers: { Authorization: `KakaoAK ${requireEnv('KAKAO_REST_KEY')}` },
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (!res.ok) throw new HttpError(502, `카카오 주소 검색 오류: ${data.message || res.status}`);
  return data.documents;
}

export const GET = handle(async (url) => {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  if (!q) throw new HttpError(400, '주소를 입력해 주세요');
  const byAddress = (await kakao('address', q)).map((d) => ({
    name: d.road_address?.building_name || d.address_name,
    address: d.road_address?.address_name || d.address_name,
    lat: Number(d.y),
    lng: Number(d.x),
  }));
  if (byAddress.length) return byAddress;
  return (await kakao('keyword', q)).map((d) => ({
    name: d.place_name,
    address: d.road_address_name || d.address_name,
    lat: Number(d.y),
    lng: Number(d.x),
  }));
});
