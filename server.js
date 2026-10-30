// 로컬 개발 서버: index.html 제공 + /api/* 를 api/*.js 의 GET/POST 핸들러로 연결
// 실행: node server.js  (휴대폰은 같은 와이파이에서 http://<PC IP>:3000)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT) || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };

if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/[^a-z0-9-]/gi, '');
      const file = join(ROOT, 'api', `${name}.js`);
      if (!name || name.startsWith('_') || !existsSync(file)) return send(res, 404, 'not found');
      const handler = (await import(`./api/${name}.js`))[req.method];
      if (!handler) return send(res, 405, 'method not allowed');
      const body = req.method === 'POST' ? Buffer.concat(await Array.fromAsync(req)) : undefined;
      const response = await handler(new Request(url, { method: req.method, headers: req.headers, body }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(await response.text());
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname));
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT) || rel.includes('.env')) return send(res, 403, 'forbidden');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    send(res, e.code === 'ENOENT' ? 404 : 500, e.message);
  }
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces()).flat().filter((n) => n.family === 'IPv4' && !n.internal);
  console.log(`http://localhost:${PORT}`);
  for (const n of ips) console.log(`http://${n.address}:${PORT}  (같은 와이파이의 휴대폰)`);
});

function send(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}
