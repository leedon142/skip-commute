// GET /api/stop-info?lat=37.61&lng=126.99 — 이 자리 주변 날씨·사고 (정류장 제보 탭)
// 날씨: 기상청 예보 + 근처 학우 날씨 제보(요약은 15분 안, 목록 weatherFeed는 2시간) · 사고·통제: 서울시 실시간 돌발정보(반경 1.5km)
// 둘 중 하나가 실패해도 나머지는 보여 주고, 실패한 쪽은 오류 문구를 같이 줌
import { handle, HttpError } from './_lib.js';
import { nearbyIncidents } from './_incidents.js';
import { weatherAt } from './_weather.js';
import { listReports, summarizeWeather, weatherFeed } from './_reports.js';

export const INCIDENT_RADIUS_M = 1500;

export const GET = handle(async (url) => {
  const pos = { lat: Number(url.searchParams.get('lat')), lng: Number(url.searchParams.get('lng')) };
  if (!pos.lat || !pos.lng) throw new HttpError(400, 'lat, lng가 필요해요');
  const now = Date.now();
  const [incidents, forecast, reports] = await Promise.allSettled([
    nearbyIncidents(pos, INCIDENT_RADIUS_M, now),
    weatherAt(pos, now, now),
    listReports(now),
  ]);
  return {
    updatedAt: new Date(now).toISOString(),
    radiusM: INCIDENT_RADIUS_M,
    incidents: incidents.status === 'fulfilled' ? incidents.value : null,
    incidentsError: incidents.status === 'rejected' ? incidents.reason.message : null,
    weather: forecast.status === 'fulfilled' ? forecast.value : null,
    weatherError: forecast.status === 'rejected' ? forecast.reason.message : null,
    weatherReport: reports.status === 'fulfilled' ? summarizeWeather(reports.value, pos, now) : null,
    weatherFeed: reports.status === 'fulfilled' ? weatherFeed(reports.value, pos, now) : [],
  };
});
