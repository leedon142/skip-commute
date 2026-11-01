// 사용자끼리 공유하는 작은 저장소 (제보·셔틀 탑승 기록)
// 배포: Vercel Runtime Cache, 로컬 개발: data/.<name>.json 파일 (재시작해도 유지)
import { getCache } from '@vercel/functions';
import { readFileSync, writeFileSync } from 'node:fs';

export function sharedStore(name) {
  if (process.env.VERCEL) return getCache({ namespace: name });
  const file = new URL(`../data/.${name}.json`, import.meta.url);
  let store = {};
  try { store = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  return {
    async get(key) {
      const e = store[key];
      return e && Date.now() < e.exp ? e.value : undefined;
    },
    async set(key, value, { ttl }) {
      store[key] = { exp: Date.now() + ttl * 1000, value };
      writeFileSync(file, JSON.stringify(store));
    },
  };
}
