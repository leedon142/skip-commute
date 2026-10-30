// OCR 글자 + 색칠된 칸 위치 → 수업 목록 [{ day, start, end, name, room }]
// 요일: 위쪽 '월 화 수 …' 글자의 가로 위치, 시간: 왼쪽 '9 10 11 …' 눈금(가로 격자선)의 세로 위치

const DAYS = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const ROOM_RE = /관|호|층|동|센터|홀|\d{3}/;
// 칸이 좁아 잘린 글자 끝의 '…', '..', '.'
const TRUNC_RE = /\s*[….·]+$/;
const cx = (b) => b.x + b.w / 2;
const cy = (b) => b.y + b.h / 2;
const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };

function findColumns(items) {
  const heads = items
    .map((b) => ({ b, day: DAYS[b.text.replace(/요일$/, '').trim().toUpperCase()] }))
    .filter((h) => h.day && h.b.conf > 0.5);
  // 같은 줄(세로 위치 비슷)에 3개 이상 모인 것이 요일 머리글
  let best = [];
  for (const h of heads) {
    const row = heads.filter((o) => Math.abs(cy(o.b) - cy(h.b)) < h.b.h);
    if (row.length > best.length) best = row;
  }
  if (best.length < 3) return null;
  const cols = [...new Map(best.map((h) => [h.day, h])).values()].sort((p, q) => cx(p.b) - cx(q.b));
  const step = median(cols.slice(1).map((c, i) => cx(c.b) - cx(cols[i].b))) || 100;
  return { cols: cols.map((c) => ({ day: c.day, x: cx(c.b) })), step, headerY: median(cols.map((c) => c.b.y + c.b.h)) };
}

function findHours(items, grid) {
  const left = grid.cols[0].x - grid.step / 2;
  const labels = items
    .filter((b) => cx(b) < left && cy(b) > grid.headerY)
    .map((b) => ({ b, m: b.text.replace(/\s/g, '').match(/^(오전|오후|AM|PM)?(\d{1,2})(시|:00)?$/i) }))
    .filter((l) => l.m && Number(l.m[2]) <= 24)
    .map((l) => ({ v: Number(l.m[2]) + (/오후|PM/i.test(l.m[1] || '') && Number(l.m[2]) < 12 ? 12 : 0), y: cy(l.b), conf: l.b.conf }))
    .sort((p, q) => p.y - q.y);
  if (labels.length < 3) return null;
  // 눈금은 같은 간격 → 간격(한 시간 높이)부터 구하고, 숫자는 다수결로만 씀 (작은 숫자는 '11'→'17'처럼 잘못 읽기도 함)
  const per = median(labels.slice(1).map((l, i) => l.y - labels[i].y));
  const y0 = labels[0].y;
  const votes = new Map();
  for (const l of labels) {
    const k = Math.round((l.y - y0) / per);
    if (Math.abs(l.y - y0 - k * per) > per * 0.25) continue;
    // 에브리타임은 오후를 1, 2, 3 … 으로 적어서 +12 후보도 같이
    for (const h of [l.v - k, l.v + 12 - k]) if (h >= 5 && h <= 14) votes.set(h, (votes.get(h) || 0) + l.conf);
  }
  const h0 = [...votes].sort((p, q) => q[1] - p[1])[0]?.[0];
  if (h0 == null) return null;
  const marks = labels
    .map((l) => ({ k: Math.round((l.y - y0) / per), y: l.y }))
    .filter((l) => Math.abs(l.y - y0 - l.k * per) <= per * 0.25);
  return { labels: [...new Map(marks.map((l) => [l.k, { hour: h0 + l.k, y: l.y }])).values()], per };
}

// 가로 격자선: 주변보다 살짝 어두운 1~2px 줄이 표 너비 대부분에 걸쳐 있음
function horizontalLines(img, x0, x1, y0, y1) {
  const lum = new Float32Array(img.height);
  const xs = Math.max(0, Math.round(x0)), xe = Math.min(img.width, Math.round(x1));
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    let dark = 0, open = 0;
    for (let x = xs; x < xe; x++) {
      const p = (y * img.width + x) * 4;
      // 칸 안이나 칸 경계(위·아래가 색칠된 곳)는 빼고 빈 칸에서만 셈
      const sat = (q) => q < 0 || q >= img.data.length ? 0 : Math.max(img.data[q], img.data[q + 1], img.data[q + 2]) - Math.min(img.data[q], img.data[q + 1], img.data[q + 2]);
      if (sat(p) > 22 || sat(p - img.width * 12) > 22 || sat(p + img.width * 12) > 22) continue;
      open++;
      const l = (img.data[p] + img.data[p + 1] + img.data[p + 2]) / 3;
      const up = y > 2 ? (img.data[p - img.width * 8] + img.data[p - img.width * 8 + 1] + img.data[p - img.width * 8 + 2]) / 3 : l;
      const dn = y < img.height - 3 ? (img.data[p + img.width * 8] + img.data[p + img.width * 8 + 1] + img.data[p + img.width * 8 + 2]) / 3 : l;
      if (l < up - 4 && l < dn - 4) dark++;
    }
    lum[y] = open > (xe - xs) * 0.1 ? dark / open : 0;
  }
  const lines = [];
  for (let y = 1; y < img.height - 1; y++) {
    if (lum[y] > 0.35 && lum[y] >= lum[y - 1] && lum[y] >= lum[y + 1] && (!lines.length || y - lines.at(-1) > 3)) lines.push(y);
  }
  return lines;
}

// 시간 눈금 → 정확한 세로 위치 (가까운 격자선이 있으면 그 선, 없으면 숫자 가운데)
function hourScale(img, grid, hours) {
  const right = grid.cols.at(-1).x + grid.step / 2;
  const lines = horizontalLines(img, grid.cols[0].x - grid.step / 2, right, Math.round(grid.headerY), img.height);
  const pts = hours.labels.map((l) => {
    const near = lines.filter((y) => Math.abs(y - l.y) < hours.per * 0.45).sort((a, b) => Math.abs(a - l.y) - Math.abs(b - l.y))[0];
    return { hour: l.hour, y: near ?? l.y };
  });
  return (y) => {
    // 양 끝은 직선 연장, 가운데는 구간별 보간
    let a = pts[0], b = pts[1];
    for (let i = 0; i < pts.length - 1; i++) {
      if (y >= pts[i].y) { a = pts[i]; b = pts[i + 1]; }
    }
    return a.hour + ((y - a.y) / (b.y - a.y)) * (b.hour - a.hour);
  };
}

// 색칠된 수업 칸: 회색·흰색이 아닌(채도 있는) 픽셀 덩어리.
// 위아래로 붙은 다른 수업은 색이 달라서 색이 비슷한 이웃끼리만 이어 붙임
function colorBlocks(img, x0, x1, y0, y1, minW, minH) {
  const S = 1;
  const W = Math.ceil(img.width / S), H = Math.ceil(img.height / S);
  const col = new Int16Array(W * H * 3).fill(-1);
  for (let gy = Math.max(0, Math.floor(y0 / S)); gy < Math.min(H, Math.ceil(y1 / S)); gy++) {
    for (let gx = Math.max(0, Math.floor(x0 / S)); gx < Math.min(W, Math.ceil(x1 / S)); gx++) {
      let n = 0, r = 0, g = 0, b = 0;
      for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
        const x = gx * S + dx, y = gy * S + dy;
        if (x >= img.width || y >= img.height) continue;
        const p = (y * img.width + x) * 4;
        const R = img.data[p], G = img.data[p + 1], B = img.data[p + 2];
        if (Math.max(R, G, B) - Math.min(R, G, B) > 22) { n++; r += R; g += G; b += B; }
      }
      if (n === S * S) col.set([r / n, g / n, b / n], (gy * W + gx) * 3);
    }
  }
  const diff = (i, j) => Math.abs(col[i * 3] - col[j * 3]) + Math.abs(col[i * 3 + 1] - col[j * 3 + 1]) + Math.abs(col[i * 3 + 2] - col[j * 3 + 2]);
  // 경계의 섞인 색(사진 압축 번짐)은 빼고 주변과 같은 색인 픽셀만 씀 → 칸 사이에 생긴 다리가 끊김
  const core = new Uint8Array(W * H);
  for (let i = W + 1; i < W * H - W - 1; i++) {
    if (col[i * 3] < 0) continue;
    core[i] = [i - 1, i + 1, i - W, i + W].every((k) => col[k * 3] >= 0 && diff(i, k) < 24) ? 1 : 0;
  }
  const on = (i) => core[i] === 1;
  const near = (i, j) => diff(i, j) < 45;
  const seen = new Uint8Array(W * H);
  let rects = [];
  for (let i = 0; i < W * H; i++) {
    if (!on(i) || seen[i]) continue;
    let ax = W, ay = H, bx = 0, by = 0;
    const st = [i];
    seen[i] = 1;
    while (st.length) {
      const j = st.pop();
      const px = j % W, py = (j - px) / W;
      ax = Math.min(ax, px); bx = Math.max(bx, px); ay = Math.min(ay, py); by = Math.max(by, py);
      for (const k of [j - 1, j + 1, j - W, j + W]) {
        if (k < 0 || k >= W * H || seen[k] || !on(k) || !near(j, k)) continue;
        if ((k === j - 1 && px === 0) || (k === j + 1 && px === W - 1)) continue;
        seen[k] = 1;
        st.push(k);
      }
    }
    rects.push({ x: ax * S, y: ay * S, w: (bx - ax + 1) * S, h: (by - ay + 1) * S });
  }
  rects = rects.filter((r) => r.w >= minW && r.h >= minH);
  // 칸 안의 색 띠·아이콘 같은 조각이 큰 칸 안에 들어 있으면 큰 칸에 합침
  const inside = (a, b) => {
    const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return ix > 0 && iy > 0 && ix * iy > 0.5 * Math.min(a.w * a.h, b.w * b.h);
  };
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        if (!inside(rects[i], rects[j])) continue;
        const a = rects[i], b = rects[j];
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        rects[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
        rects.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return rects;
}

const hhmm = (h) => {
  const m = Math.round((h * 60) / 5) * 5;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export function parseTimetable(img, items) {
  const grid = findColumns(items);
  if (!grid) throw new Error('요일(월 화 수 …) 머리글을 찾지 못했어요. 시간표 전체가 보이게 찍어 주세요');
  const hours = findHours(items, grid);
  if (!hours) throw new Error('왼쪽 시간 눈금(9, 10, 11 …)을 찾지 못했어요');
  const toHour = hourScale(img, grid, hours);
  const x0 = grid.cols[0].x - grid.step / 2, x1 = grid.cols.at(-1).x + grid.step / 2;
  const top = hours.labels[0].y - hours.per, bottom = hours.labels.at(-1).y + hours.per * 2;
  const blocks = colorBlocks(img, x0, x1, Math.max(grid.headerY + 2, top), bottom, grid.step * 0.35, hours.per * 0.4);
  const classes = [];
  for (const r of blocks) {
    const col = grid.cols.reduce((a, c) => (Math.abs(c.x - cx(r)) < Math.abs(a.x - cx(r)) ? c : a));
    if (Math.abs(col.x - cx(r)) > grid.step * 0.6) continue;
    const texts = items
      .filter((b) => cx(b) > r.x && cx(b) < r.x + r.w && cy(b) > r.y && cy(b) < r.y + r.h && b.conf > 0.5)
      .sort((a, b) => a.y - b.y);
    if (!texts.length) continue;
    const roomAt = texts.findIndex((t, i) => i > 0 && ROOM_RE.test(t.text));
    const nameLines = roomAt > 0 ? texts.slice(0, roomAt) : texts.slice(0, 1);
    classes.push({
      day: col.day,
      start: hhmm(toHour(r.y)),
      end: hhmm(toHour(r.y + r.h)),
      // 줄바꿈된 과목명: 한글은 붙이고 영어 단어 사이는 띄움
      name: nameLines.map((t) => t.text).reduce((a, t) => a + (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z]/.test(t) ? ' ' : '') + t, '').replace(TRUNC_RE, ''),
      // 강의실도 칸이 좁으면 '미래관2층31호' + '실'처럼 줄이 나뉨
      room: roomAt > 0 ? texts.slice(roomAt).map((t) => t.text).join('').replace(TRUNC_RE, '') : '',
    });
  }
  return classes.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
}
