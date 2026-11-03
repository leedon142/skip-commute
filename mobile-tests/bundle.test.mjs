// 설치 앱 번들 검사: 비밀·서버 파일 없음, 필요한 자산 있음, 스크립트 문법, /api/만 서버 주소로 보내는지
// 실행: npm run mobile:test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const WWW = join(import.meta.dirname, '..', 'mobile', 'www');
const html = readFileSync(join(WWW, 'index.html'), 'utf8');

test('필요한 자산이 들어 있음', () => {
  for (const f of ['vendor/tailwind.css', 'vendor/phosphor/duotone.css', 'vendor/pretendard/PretendardVariable.woff2',
    'vendor/ort/ort-wasm-simd-threaded.wasm', 'ocr/browser.js', 'models/ocr/det.onnx', 'models/ocr/rec.onnx', 'models/ocr/dict.txt']) {
    assert.ok(existsSync(join(WWW, f)), f);
  }
});

test('비밀·서버 파일이 없음', () => {
  for (const f of ['.env', 'api', 'data', 'server.js', 'artifacts', 'package.json']) assert.ok(!existsSync(join(WWW, f)), f);
});

test('인라인 스크립트 문법', () => {
  for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(code));
});

test('API 주소가 채워짐', () => {
  assert.match(html, /<meta name="skip-api-base" content="https?:\/\/[^"]+">/);
});

// 첫 스크립트의 앱 판별·fetch 감싸기 부분만 가짜 window에서 실행
function runHead(native) {
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1].split('// 폰(홈 화면에 추가한 앱')[0];
  const calls = [];
  const base = html.match(/name="skip-api-base" content="([^"]*)"/)[1];
  const window = { Capacitor: native ? { isNativePlatform: () => true } : undefined, fetch: (u, init) => calls.push([u, init]) };
  const document = { querySelector: () => ({ content: base }) };
  vm.runInNewContext(`${code}; window.fetch('/api/recommend?x=1', { method: 'POST' }); window.fetch('/models/ocr/det.onnx'); window.fetch(new URL('https://example.com/api/x'));`, { window, document, URL });
  return { calls, base };
}

test('앱: /api/만 서버 주소로, 나머지는 기기 안', () => {
  const { calls, base } = runHead(true);
  assert.equal(calls[0][0], `${base}/api/recommend?x=1`);
  assert.equal(calls[0][1].method, 'POST'); // 요청 옵션은 그대로 전달
  assert.equal(calls[1][0], '/models/ocr/det.onnx');
  assert.ok(calls[2][0] instanceof URL);
});

test('웹: 주소를 바꾸지 않음', () => {
  const { calls } = runHead(false);
  assert.equal(calls[0][0], '/api/recommend?x=1');
});
