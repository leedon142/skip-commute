// PaddleOCR (PP-OCRv3 글자 위치 + PP-OCRv5 한국어 인식) — 브라우저·Node 공용
// 사진은 기기 밖으로 나가지 않음. ort(onnxruntime)와 모델 바이트는 호출하는 쪽이 넣어줌
// image: { width, height, data: RGBA Uint8ClampedArray }

const DET_LIMIT = 1280; // 긴 변 최대 (작은 글씨 때문에 기본 960보다 크게)
const DET_THRESH = 0.3;
const BOX_THRESH = 0.5;
const UNCLIP = 1.6;
const REC_H = 48;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export async function createOcr(ort, { det, rec, dict }, opts = { executionProviders: ['wasm'] }) {
  const detSession = await ort.InferenceSession.create(det, opts);
  const recSession = await ort.InferenceSession.create(rec, opts);
  const chars = dict.split(/\r?\n/).filter((c, i, a) => c !== '' || i < a.length - 1);

  // 이미지 일부를 (w×h)로 줄여 BGR CHW 텐서로. norm: 채널별 (값 → 텐서 값)
  function toTensor(img, sx, sy, sw, sh, w, h, norm) {
    const out = new Float32Array(3 * w * h);
    for (let y = 0; y < h; y++) {
      const oy = Math.min(img.height - 1, Math.floor(sy + ((y + 0.5) * sh) / h));
      for (let x = 0; x < w; x++) {
        const ox = Math.min(img.width - 1, Math.floor(sx + ((x + 0.5) * sw) / w));
        const p = (oy * img.width + ox) * 4;
        // Paddle은 OpenCV(BGR) 순서로 학습됨
        out[y * w + x] = norm(0, img.data[p + 2]);
        out[w * h + y * w + x] = norm(1, img.data[p + 1]);
        out[2 * w * h + y * w + x] = norm(2, img.data[p]);
      }
    }
    return new ort.Tensor('float32', out, [1, 3, h, w]);
  }

  async function detect(img) {
    const scale = Math.min(1, DET_LIMIT / Math.max(img.width, img.height));
    const w = Math.max(32, Math.round((img.width * scale) / 32) * 32);
    const h = Math.max(32, Math.round((img.height * scale) / 32) * 32);
    const x = toTensor(img, 0, 0, img.width, img.height, w, h, (c, v) => (v / 255 - MEAN[c]) / STD[c]);
    const prob = (await detSession.run({ x }))[detSession.outputNames[0]].data;
    // 확률 지도 → 연결된 덩어리마다 상자
    const seen = new Uint8Array(w * h);
    const boxes = [];
    const stack = [];
    for (let i = 0; i < w * h; i++) {
      if (seen[i] || prob[i] < DET_THRESH) continue;
      let x0 = w, y0 = h, x1 = 0, y1 = 0, sum = 0, n = 0;
      stack.push(i);
      seen[i] = 1;
      while (stack.length) {
        const j = stack.pop();
        const px = j % w, py = (j - px) / w;
        sum += prob[j]; n++;
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        for (const k of [j - 1, j + 1, j - w, j + w]) {
          if (k < 0 || k >= w * h || seen[k] || prob[k] < DET_THRESH) continue;
          if ((k === j - 1 && px === 0) || (k === j + 1 && px === w - 1)) continue;
          seen[k] = 1;
          stack.push(k);
        }
      }
      if (n < 6 || sum / n < BOX_THRESH) continue;
      // DB 후처리처럼 줄어든 글자 영역을 다시 넓힘
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const d = (bw * bh * UNCLIP) / (2 * (bw + bh));
      const fx = img.width / w, fy = img.height / h;
      boxes.push({
        x: Math.max(0, (x0 - d) * fx), y: Math.max(0, (y0 - d) * fy),
        w: Math.min(img.width, (x1 + 1 + d) * fx) - Math.max(0, (x0 - d) * fx),
        h: Math.min(img.height, (y1 + 1 + d) * fy) - Math.max(0, (y0 - d) * fy),
      });
    }
    return boxes.filter((b) => b.w > 4 && b.h > 4);
  }

  async function recognize(img, b) {
    const w = Math.max(16, Math.min(1600, Math.ceil((REC_H * b.w) / b.h)));
    const x = toTensor(img, b.x, b.y, b.w, b.h, w, REC_H, (_, v) => (v / 255 - 0.5) / 0.5);
    const out = (await recSession.run({ x }))[recSession.outputNames[0]];
    const [, T, C] = out.dims;
    let text = '', prev = 0, conf = 0, n = 0;
    for (let t = 0; t < T; t++) {
      let best = 0, bv = -Infinity;
      for (let c = 0; c < C; c++) {
        const v = out.data[t * C + c];
        if (v > bv) { bv = v; best = c; }
      }
      // 0 = 빈칸(blank), 마지막 = 띄어쓰기
      if (best !== 0 && best !== prev) {
        text += best - 1 < chars.length ? chars[best - 1] : ' ';
        conf += bv; n++;
      }
      prev = best;
    }
    return { text: text.trim(), conf: n ? conf / n : 0 };
  }

  return {
    // 글자 상자마다 { x, y, w, h, text, conf }
    async read(img) {
      const boxes = await detect(img);
      const out = [];
      for (const b of boxes) {
        const r = await recognize(img, b);
        if (r.text) out.push({ ...b, ...r });
      }
      return out;
    },
  };
}
