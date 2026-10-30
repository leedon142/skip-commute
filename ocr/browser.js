// 시간표 사진 → 수업 목록을 브라우저 안에서만 처리 (사진은 기기 밖으로 나가지 않음)
// 처음 한 번 인식 엔진·모델을 받고, 이후엔 브라우저 캐시를 씀
import { createOcr } from './paddle.js';
import { parseTimetable } from './timetable.js';

// onnxruntime-web 1.20.1 (vendor/ort에 복사해 둠, CDN 없이)
const ORT = '/vendor/ort/';
const MAX_SIDE = 1600;

let engine = null;

function loadEngine(onStatus) {
  engine ??= (async () => {
    onStatus?.('인식 모델 준비 중… (처음 한 번만 받아요)');
    const ort = await import(`${ORT}ort.wasm.min.mjs`);
    ort.env.wasm.wasmPaths = ORT;
    // 여러 스레드는 별도 보안 헤더가 필요해서 한 스레드로
    ort.env.wasm.numThreads = 1;
    const get = (path) => fetch(path).then((res) => {
      if (!res.ok) throw new Error('인식 모델을 받지 못했어요');
      return res;
    });
    const [det, rec, dict] = await Promise.all([
      get('/models/ocr/det.onnx').then((r) => r.arrayBuffer()),
      get('/models/ocr/rec.onnx').then((r) => r.arrayBuffer()),
      get('/models/ocr/dict.txt').then((r) => r.text()),
    ]);
    return createOcr(ort, { det: new Uint8Array(det), rec: new Uint8Array(rec), dict });
  })();
  // 실패하면 다음에 다시 받게
  engine.catch(() => { engine = null; });
  return engine;
}

function toPixels(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = () => reject(new Error('사진을 열 수 없어요'));
    img.src = URL.createObjectURL(file);
  });
}

export async function readTimetable(file, onStatus) {
  const [ocr, img] = await Promise.all([loadEngine(onStatus), toPixels(file)]);
  onStatus?.('사진에서 글자 읽는 중… (기기 안에서 처리)');
  const items = await ocr.read(img);
  const classes = parseTimetable(img, items);
  if (!classes.length) throw new Error('수업 칸을 찾지 못했어요. 시간표 전체가 보이게 다시 찍어 주세요');
  return classes;
}
