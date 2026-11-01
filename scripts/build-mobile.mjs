// 앱(APK)에 넣을 웹 자산만 mobile/www로 복사. 허용 목록 방식이라 .env·api/·data/·artifacts/ 등은 들어가지 않음
// 앱의 /api/ 요청은 SKIP_API_BASE(기본: 배포 주소)로 보냄. 예) SKIP_API_BASE=http://localhost:3000 npm run mobile:build
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'mobile', 'www');
const INCLUDE = ['index.html', 'manifest.webmanifest', 'icons', 'vendor', 'ocr', 'models/ocr'];
const API_BASE = process.env.SKIP_API_BASE || 'https://skip-commute.vercel.app';
// 번들에 있으면 안 되는 것 (비밀·서버 코드·사적 캐시)
const FORBIDDEN = [/(^|\/)\.env/, /^api\//, /^data\//, /^artifacts\//, /^\.git/, /^\.vercel/, /\.(jks|keystore|p12)$/];

if (!/^https:\/\//.test(API_BASE) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API_BASE)) {
  throw new Error(`SKIP_API_BASE는 https 주소이거나 http://localhost(USB reverse용)여야 해요: ${API_BASE}`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const p of INCLUDE) {
  const src = join(ROOT, p);
  if (!existsSync(src)) throw new Error(`없는 파일: ${p}`);
  cpSync(src, join(OUT, p), { recursive: true });
}

// 앱용 API 주소를 한 곳(meta)에만 넣음. 웹은 meta가 비어 있어 지금처럼 상대 경로
const htmlPath = join(OUT, 'index.html');
const html = readFileSync(htmlPath, 'utf8');
const marker = '<meta name="skip-api-base" content="">';
if (!html.includes(marker)) throw new Error('index.html에 skip-api-base meta가 없어요');
writeFileSync(htmlPath, html.replace(marker, `<meta name="skip-api-base" content="${API_BASE}">`));

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(relative(OUT, full).replaceAll('\\', '/'));
  }
};
walk(OUT);
const bad = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));
if (bad.length) throw new Error(`번들에 들어가면 안 되는 파일: ${bad.join(', ')}`);

const size = files.reduce((n, f) => n + statSync(join(OUT, f)).size, 0);
console.log(`mobile/www: ${files.length}개 파일, ${(size / 1024 / 1024).toFixed(1)}MB, API → ${API_BASE}`);
