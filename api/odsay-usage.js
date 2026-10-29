// GET /api/odsay-usage?days=30 — ODsay 날짜별 호출 수·평균·예상 비용 (건당 25원)
import { handle } from './_lib.js';
import { odsayUsage } from './_odsay.js';

export const GET = handle(async (url) => odsayUsage(Number(url.searchParams.get('days')) || 30));
