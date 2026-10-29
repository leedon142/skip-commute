// 웹 푸시 발송 + 예약 (Upstash QStash)
// 예약 메시지 안에 구독 정보와 추천 조건이 같이 들어 있어서 서버 DB 없이 동작한다.
// 발송 시각이 되면 QStash가 /api/push-send를 부르고, 그때 실시간으로 다시 계산해서 알림 내용을 채운다.
import webpush from 'web-push';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { requireEnv, HttpError } from './_lib.js';

const QSTASH_URL = () => (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/$/, '');
const MAX_DELAY_MS = 7 * 24 * 3600e3; // QStash 무료 요금제 최대 지연

let vapidReady = false;
function vapid(origin) {
  if (vapidReady) return;
  // 애플 푸시 서버는 subject로 localhost를 받지 않음 → 배포 주소나 메일 주소
  const subject = process.env.VAPID_SUBJECT
    || (origin?.startsWith('https://') ? origin : 'mailto:skip-commute@users.noreply.github.com');
  webpush.setVapidDetails(subject, requireEnv('VAPID_PUBLIC_KEY'), requireEnv('VAPID_PRIVATE_KEY'));
  vapidReady = true;
}

export function publicKey() {
  return requireEnv('VAPID_PUBLIC_KEY');
}

export function canSchedule() {
  return !!process.env.QSTASH_TOKEN;
}

export function checkSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new HttpError(400, '알림 구독 정보가 올바르지 않아요. 알림을 다시 켜 주세요.');
  }
  return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
}

// payload: { title, body, url, tag }. 구독이 만료됐으면 { gone: true }
export async function sendPush(sub, payload, origin) {
  vapid(origin);
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 15 * 60, urgency: 'high' });
    return { sent: true };
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) return { gone: true };
    throw new HttpError(502, `푸시 발송 실패 (${e.statusCode ?? '네트워크'}): ${String(e.body || e.message).slice(0, 200)}`);
  }
}

// at(epoch ms)에 destination으로 body를 POST하도록 예약 → messageId
export async function schedule(destination, body, at) {
  const token = requireEnv('QSTASH_TOKEN');
  if (!/^https:\/\//.test(destination)) {
    throw new HttpError(400, '예약 알림은 배포된 https 주소에서만 돼요 (QStash가 localhost를 부를 수 없음)');
  }
  if (at - Date.now() > MAX_DELAY_MS) throw new HttpError(400, '7일보다 먼 알림은 예약할 수 없어요');
  const res = await fetch(`${QSTASH_URL()}/v2/publish/${destination}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Upstash-Not-Before': String(Math.floor(Math.max(at, Date.now()) / 1000)),
      'Upstash-Retries': '1',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `알림 예약 실패: ${data.error || res.status}`);
  return data.messageId;
}

// 이미 보냈거나 없는 메시지면 조용히 넘어감
export async function cancel(messageId) {
  if (!messageId || !/^[\w-]+$/.test(messageId) || !process.env.QSTASH_TOKEN) return;
  await fetch(`${QSTASH_URL()}/v2/messages/${messageId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${process.env.QSTASH_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const unpad = (s) => s.replace(/=+$/, '');

// QStash가 보낸 요청인지 확인: Upstash-Signature JWT (HS256, 현재 키 또는 다음 키)
export function verifyQStash(signature, rawBody) {
  const keys = [process.env.QSTASH_CURRENT_SIGNING_KEY, process.env.QSTASH_NEXT_SIGNING_KEY].filter(Boolean);
  if (!keys.length) throw new HttpError(503, 'QSTASH_CURRENT_SIGNING_KEY 환경변수가 없어요');
  const [h, p, s] = String(signature || '').split('.');
  if (!h || !p || !s) throw new HttpError(401, '서명 없음');
  const ok = keys.some((k) => {
    const expect = Buffer.from(createHmac('sha256', k).update(`${h}.${p}`).digest('base64url'));
    const got = Buffer.from(s);
    return expect.length === got.length && timingSafeEqual(expect, got);
  });
  if (!ok) throw new HttpError(401, '서명이 맞지 않아요');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const now = Date.now() / 1000;
  if (claims.iss !== 'Upstash' || (claims.exp && now > claims.exp + 60) || (claims.nbf && now < claims.nbf - 60)) {
    throw new HttpError(401, '서명 기간이 맞지 않아요');
  }
  if (!String(claims.sub || '').endsWith('/api/push-send')) throw new HttpError(401, '다른 주소용 서명이에요');
  if (unpad(claims.body || '') !== unpad(b64url(createHash('sha256').update(rawBody).digest()))) {
    throw new HttpError(401, '본문이 바뀌었어요');
  }
}
