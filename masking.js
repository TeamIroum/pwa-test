// 기기 마스킹: 얼굴·번호판·차량을 찾아 캔버스에서 가린다. 기준은 ai/contract/APP_MASKING_GUIDE.md, 서버 구현은 ai/privacy.py.
//
// 원본 다루기 (안내서 5장)
//   - 원본 캔버스는 이 모듈 밖으로 내보내지 않고, 끝나면 크기를 0으로 만든다. 어디에도 저장하지 않는다.
//   - 실패하면 예외를 던진다. 부른 쪽은 사진을 버리고 다시 찍게 한다 (가리지 못한 사진은 전송·저장 경로가 없음).
//   - 사진·캔버스 내용은 콘솔에 찍지 않는다.
import { detectFaces } from "./lib/yunet.mjs";

const ORT_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
const MP_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/";

export const MASKING_VERSION = "pwa-test-2";          // 입력 크기·가리는 방법을 바꾸면 올림 (모델이 바뀌면 아래 해시가 자동으로 바뀜)
let modelVersion = null;                                // 서버 모델 목록의 해시
// 업무 API에 보내는 maskingVersion: 규칙 버전 + 모델 해시. 모델 파일이 바뀌면 저절로 달라진다
export const maskingVersion = () => (modelVersion ? `${MASKING_VERSION}+${modelVersion}` : MASKING_VERSION);
export const DETECTOR = "yunet+plate-t384+effdet0";
// 모델 주소는 서버의 model-manifest.json에서 받는다 (주소에 내용 해시가 붙어 있어 모델이 바뀌면 캐시를 새로 받음)
export const MODEL_FILES = {};

const DETECT_MAX_SIDE = 2400;   // 이보다 크면 줄여서 찾고 좌표를 되돌림
const OUTPUT_MAX_SIDE = 1568;   // AI가 판독·저장하는 긴 변
const JPEG_QUALITY = 0.88;      // 서버 images.JPEG_QUALITY
const PLATE_SIZE = 384;
const PLATE_CONF = 0.15;        // 서버 PLATE_PRETRAINED_CONF
const VEHICLE_CONF = 0.4;       // 서버 VEHICLE_CONF
const VEHICLE_LABELS = ["car", "bus", "truck", "motorcycle"];
const PAD = { face: 0.25, plate: 0.2, vehicle: 0.05 };
const PLATE_FILL = "#3C3C3C";

let ort, faceSession, plateSession, vehicleDetector;
let blurSupported = null;
export const status = { face: "대기", plate: "대기", vehicle: "대기", backend: "" };

// ---------------------------------------------------------------- 모델 불러오기
let loading = null;
export function loadModels(onChange = () => {}) {
  if (!loading) loading = doLoad(onChange).catch((e) => { loading = null; throw e; });
  return loading;
}

async function doLoad(onChange) {
  const set = (k, v) => { status[k] = v; onChange(); };
  const manifest = await (await fetch(new URL("./model-manifest.json", import.meta.url), { cache: "no-cache" })).json();
  Object.assign(MODEL_FILES, Object.fromEntries(
    Object.entries(manifest.files).map(([k, u]) => [k, new URL(u, import.meta.url).href])));
  modelVersion = manifest.version;
  ort = await import(`${ORT_URL}ort.wasm.min.mjs`);
  ort.env.wasm.wasmPaths = ORT_URL;
  // 여러 스레드는 교차 출처 격리(COOP/COEP)가 있어야 켜짐 (안내서 7장)
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  status.backend = `wasm ×${ort.env.wasm.numThreads}`;
  const opts = { executionProviders: ["wasm"] };

  const jobs = [
    (async () => { set("face", "받는 중"); faceSession = await ort.InferenceSession.create(MODEL_FILES.face, opts); set("face", "준비"); })(),
    (async () => { set("plate", "받는 중"); plateSession = await ort.InferenceSession.create(MODEL_FILES.plate, opts); set("plate", "준비"); })(),
    (async () => {
      set("vehicle", "받는 중");
      const { FilesetResolver, ObjectDetector } = await import(`${MP_URL}vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${MP_URL}wasm`);
      vehicleDetector = await ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_FILES.vehicle, delegate: "CPU" },
        runningMode: "IMAGE", scoreThreshold: VEHICLE_CONF, maxResults: -1, categoryAllowlist: VEHICLE_LABELS,
      });
      set("vehicle", "준비");
    })(),
  ];
  const results = await Promise.allSettled(jobs);
  results.forEach((r, i) => { if (r.status === "rejected") set(["face", "plate", "vehicle"][i], "실패"); });
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw new Error(`모델을 불러오지 못했습니다: ${failed.reason?.message || failed.reason}`);
}

export const ready = () => Boolean(faceSession && plateSession && vehicleDetector);

// ---------------------------------------------------------------- 검출
async function findPlates(work) {
  // open-image-models 전처리와 같음: 비율 유지 축소 + 회색(114) 여백, RGB, 0~1
  const W = work.width, H = work.height, S = PLATE_SIZE;
  const r = Math.min(S / W, S / H);
  const nw = Math.round(W * r), nh = Math.round(H * r);
  const dw = (S - nw) / 2, dh = (S - nh) / 2;
  const c = canvas(S, S);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, S, S);
  ctx.imageSmoothingQuality = "low";   // 서버(cv2 INTER_LINEAR)에 가까운 단순 보간. "high"는 점수가 달라짐
  ctx.drawImage(work, Math.round(dw - 0.1), Math.round(dh - 0.1), nw, nh);
  const px = ctx.getImageData(0, 0, S, S).data;
  release(c);
  const plane = S * S, data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    data[i] = px[i * 4] / 255;
    data[plane + i] = px[i * 4 + 1] / 255;
    data[2 * plane + i] = px[i * 4 + 2] / 255;
  }
  const out = await plateSession.run({ [plateSession.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, S, S]) });
  const t = out[plateSession.outputNames[0]];
  const rows = t.dims[0], cols = t.dims[1], v = t.data;
  const boxes = [];
  for (let i = 0; i < rows; i++) {
    const o = i * cols, score = v[o + 6];   // [batch, x1, y1, x2, y2, class, score]
    if (score < PLATE_CONF) continue;
    const x1 = (v[o + 1] - dw) / r, y1 = (v[o + 2] - dh) / r, x2 = (v[o + 3] - dw) / r, y2 = (v[o + 4] - dh) / r;
    if (!plausiblePlate(x1, y1, x2, y2, W, H)) continue;
    boxes.push(box(x1, y1, x2 - x1, y2 - y1, "plate", score));
  }
  return boxes;
}

// 작은 번호판 모델(t-384)은 보도 점자블록 같은 노란 직사각형 무늬를 사진 전체 크기의 번호판으로 잡기도 한다.
// 그대로 가리면 사진 전체가 회색이 되어 판독을 못 하므로, 번호판일 수 없는 상자는 버린다.
// 놓친 번호판은 서버가 큰 모델(s-608)로 한 번 더 가린다.
const PLATE_MAX_AREA = 0.25;    // 사진의 25% 이상을 차지하는 번호판은 없다고 봄
const PLATE_MIN_ASPECT = 1.3;   // 한국 번호판은 가로가 세로의 약 2~4.7배
function plausiblePlate(x1, y1, x2, y2, W, H) {
  const w = Math.min(W, x2) - Math.max(0, x1), h = Math.min(H, y2) - Math.max(0, y1);
  if (w <= 0 || h <= 0) return false;
  return (w * h) / (W * H) < PLATE_MAX_AREA && w / h >= PLATE_MIN_ASPECT;
}

function findVehicles(work) {
  const res = vehicleDetector.detect(work);
  return (res.detections || []).map((d) => {
    const b = d.boundingBox;
    return box(b.originX, b.originY, b.width, b.height, "vehicle", d.categories?.[0]?.score ?? 0);
  });
}

const box = (x, y, w, h, kind, score) => ({ x: Math.trunc(x), y: Math.trunc(y), w: Math.trunc(w), h: Math.trunc(h), kind, score });
const scaled = (b, k) => ({ ...b, x: Math.trunc(b.x * k), y: Math.trunc(b.y * k), w: Math.round(b.w * k), h: Math.round(b.h * k) });

function padded(b, W, H) {
  const p = PAD[b.kind];
  const dx = Math.trunc(b.w * p), dy = Math.trunc(b.h * p);
  const x0 = Math.max(0, b.x - dx), y0 = Math.max(0, b.y - dy);
  const x1 = Math.min(W, b.x + b.w + dx), y1 = Math.min(H, b.y + b.h + dy);
  return { ...b, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------- 가리기
function canBlur() {
  if (blurSupported !== null) return blurSupported;
  // 캔버스 filter를 실제로 그려 확인 (지원하지 않는 브라우저는 무시하고 그냥 그림)
  const c = canvas(9, 1), ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(4, 0, 1, 1);
  const t = canvas(9, 1), tctx = t.getContext("2d", { willReadFrequently: true });
  tctx.filter = "blur(2px)";
  tctx.drawImage(c, 0, 0);
  blurSupported = tctx.getImageData(2, 0, 1, 1).data[3] > 0;
  release(c); release(t);
  return blurSupported;
}

// 서버 _pixelate와 같은 정도: 가로 6칸 모자이크 + 가우시안 흐림. 흐림이 안 되면 4칸으로 더 거칠게.
function pixelate(ctx, b) {
  const blur = canBlur();
  const cell = Math.max(1, Math.floor(b.w / (blur ? 6 : 4)));
  const sw = Math.max(1, Math.floor(b.w / cell)), sh = Math.max(1, Math.floor(b.h / cell));
  const small = canvas(sw, sh), sctx = small.getContext("2d");
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(ctx.canvas, b.x, b.y, b.w, b.h, 0, 0, sw, sh);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, sw, sh, b.x, b.y, b.w, b.h);
  ctx.imageSmoothingEnabled = true;
  release(small);
  if (!blur) return;
  const k = Math.max(3, Math.floor(Math.min(b.w, b.h) / 4) | 1);
  const sigma = 0.3 * ((k - 1) * 0.5 - 1) + 0.8;        // OpenCV가 커널 크기로 정하는 sigma
  const tmp = canvas(b.w, b.h);
  tmp.getContext("2d").drawImage(ctx.canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  // 흐림 가장자리는 반투명이 되지만 그 아래는 이미 모자이크라 원본이 비치지 않는다
  ctx.save();
  ctx.beginPath();
  ctx.rect(b.x, b.y, b.w, b.h);
  ctx.clip();
  ctx.filter = `blur(${sigma.toFixed(2)}px)`;
  ctx.drawImage(tmp, b.x, b.y);
  ctx.restore();
  release(tmp);
}

// ---------------------------------------------------------------- 전체 과정
// source: 촬영 순간을 그린 캔버스(원본). 이 함수가 끝나면 크기가 0이 된다(성공·실패 모두).
// 돌려주는 것: { blob(JPEG), report(업무 API deviceMaskReport), boxes(0~1 비율, 화면 확인용), size, timings }
export async function maskCapture(source, appVersion) {
  const t0 = performance.now();
  const timings = {};
  const lap = (name, since) => { const now = performance.now(); timings[name] = Math.round(now - since); return now; };
  let work = null, out = null;
  try {
    if (!ready()) throw new Error("마스킹 모델이 준비되지 않았습니다");
    const W = source.width, H = source.height;
    const k = Math.min(1, DETECT_MAX_SIDE / Math.max(W, H));
    work = source;
    if (k < 1) {
      work = canvas(Math.round(W * k), Math.round(H * k));
      const wctx = work.getContext("2d");
      wctx.imageSmoothingQuality = "high";
      wctx.drawImage(source, 0, 0, work.width, work.height);
    }
    const back = (b) => (k < 1 ? scaled(b, 1 / k) : b);

    let t = performance.now();
    const img = work.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, work.width, work.height);
    const faces = (await detectFaces(ort, faceSession, img.data, img.width, img.height))
      .map((f) => back(box(f.x, f.y, f.w, f.h, "face", f.score)));
    t = lap("face", t);
    const plates = (await findPlates(work)).map(back);
    t = lap("plate", t);
    // 차량 안에서 번호판을 하나도 못 찾았으면 차량 전체를 뭉갠다 (서버와 같은 규칙)
    const vehicles = findVehicles(work).map(back).filter((v) => !plates.some((p) =>
      v.x <= p.x + p.w / 2 && p.x + p.w / 2 <= v.x + v.w && v.y <= p.y + p.h / 2 && p.y + p.h / 2 <= v.y + v.h));
    t = lap("vehicle", t);
    if (work !== source) { release(work); work = null; }

    const ctx = source.getContext("2d");
    const report = { faces: 0, plates: 0, vehicles: 0, detector: DETECTOR, appVersion };
    const boxes = [];
    for (const b0 of [...faces, ...plates, ...vehicles]) {
      const b = padded(b0, W, H);
      if (b.w <= 0 || b.h <= 0) continue;
      if (b.kind === "plate") {
        ctx.fillStyle = PLATE_FILL;
        ctx.fillRect(b.x, b.y, b.w, b.h);
      } else {
        pixelate(ctx, b);
      }
      report[{ face: "faces", plate: "plates", vehicle: "vehicles" }[b.kind]] += 1;
      boxes.push({ kind: b.kind, score: +b.score.toFixed(2), box: [b.x / W, b.y / H, (b.x + b.w) / W, (b.y + b.h) / H] });
    }
    // 가린 위치를 서버에 함께 보낸다. 서버는 이미 가린 곳에서 다시 찾은 것을 '앱이 놓친 수'(server_added)로 세지 않는다
    report.boxes = boxes.map(({ kind, box: bx }) => ({ kind, box: bx.map((v) => +v.toFixed(4)) }));
    t = lap("mask", t);

    // 긴 변 1,568px JPEG. 캔버스에서 만든 JPEG에는 위치·기기 정보(EXIF)가 없다
    const ko = Math.min(1, OUTPUT_MAX_SIDE / Math.max(W, H));
    out = canvas(Math.round(W * ko), Math.round(H * ko));
    const octx = out.getContext("2d");
    octx.imageSmoothingQuality = "high";
    octx.drawImage(source, 0, 0, out.width, out.height);
    release(source);   // 원본은 여기서 버린다
    const blob = await new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error("JPEG을 만들지 못했습니다"))), "image/jpeg", JPEG_QUALITY));
    const size = { captured: [W, H], sent: [out.width, out.height] };
    lap("encode", t);
    timings.total = Math.round(performance.now() - t0);
    return { blob, report, boxes, size, timings, blur: canBlur() };
  } finally {
    release(source);
    if (work && work !== source) release(work);
    if (out) release(out);
  }
}

// ---------------------------------------------------------------- 얼굴 검출 자체 점검 (yunet_web/verify.mjs와 같은 기준)
export async function selfTestFaces(base = "./selftest/") {
  await loadModels();
  const { iou, SCORE_THRESHOLD } = await import("./lib/yunet.mjs");
  const expected = await (await fetch(`${base}expected.json`)).json();
  const lines = [];
  let failed = 0;
  for (const [name, exp] of Object.entries(expected.images)) {
    const bmp = await createImageBitmap(await (await fetch(base + name)).blob());
    const c = canvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, c.width, c.height);
    release(c);
    const t0 = performance.now();
    const got = await detectFaces(ort, faceSession, img.data, img.width, img.height);
    const ms = Math.round(performance.now() - t0);
    const problems = [], used = new Set();
    for (const e of exp.faces) {
      let best = -1, bestIou = 0;
      got.forEach((g, i) => { const v = iou(e, g); if (v > bestIou) { bestIou = v; best = i; } });
      const borderline = e.score < SCORE_THRESHOLD + 0.03;
      if (best < 0 || bestIou < 0.9) { if (!borderline) problems.push(`놓침 score=${e.score}`); continue; }
      used.add(best);
      const d = Math.abs(got[best].score - e.score);
      if (d > 0.03) problems.push(`점수 차이 ${d.toFixed(3)}`);
    }
    got.forEach((g, i) => { if (!used.has(i) && g.score >= SCORE_THRESHOLD + 0.03) problems.push(`없는 얼굴 score=${g.score.toFixed(3)}`); });
    if (problems.length) failed++;
    lines.push({ name, ok: !problems.length, expected: exp.faces.length, found: got.length, ms, problems });
  }
  return { ok: failed === 0, lines };
}

// ---------------------------------------------------------------- 도우미
function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function release(c) {
  if (c) { c.width = 0; c.height = 0; }
}
