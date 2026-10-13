// 기기 마스킹: 얼굴·번호판·차량을 찾아 캔버스에서 가린다. 기준은 ai/contract/APP_MASKING_GUIDE.md, 서버 구현은 ai/privacy.py.
//
// 원본 다루기 (안내서 5장)
//   - 원본 캔버스는 이 모듈 밖으로 내보내지 않고, 끝나면 크기를 0으로 만든다. 어디에도 저장하지 않는다.
//   - 실패하면 예외를 던진다. 부른 쪽은 사진을 버리고 다시 찍게 한다 (가리지 못한 사진은 전송·저장 경로가 없음).
//   - 사진·캔버스 내용은 콘솔에 찍지 않는다.
import { detectFaces } from "./yunet.mjs";
import { download, importRetry } from "./download.js";

// 검출 라이브러리 기본 주소. loadModels의 ortUrl·mediapipeUrl로 바꿀 수 있다 (같은 버전을 직접 올려 둘 때)
const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
const MP_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/";

// 가리는 규칙 버전. 입력 크기·가리는 방법·보내는 크기를 바꾸면 올림 (모델이 바뀌면 아래 해시가 자동으로 바뀜).
// 시험용 PWA와 시니어 앱이 이 파일을 그대로 함께 쓰므로 앱 이름은 넣지 않는다 (앱은 deviceMaskReport.appVersion으로 구분)
export const MASKING_VERSION = "mask-4";
let modelVersion = null;                                // 모델 목록의 해시
// 업무 API에 보내는 maskingVersion: 규칙 버전 + 모델 해시. 모델 파일이 바뀌면 저절로 달라진다
export const maskingVersion = () => (modelVersion ? `${MASKING_VERSION}+${modelVersion}` : MASKING_VERSION);
export const DETECTOR = "yunet+plate-t384+effdet0";
// 모델 주소는 모델 목록(model-manifest.json)에서 받거나 loadModels에 바로 넘긴다.
// 주소마다 내용 해시(?v=)가 붙어 있어야 한다: 받은 뒤 해시를 확인하고, 모델이 바뀌면 캐시를 새로 받는다
// (해시가 없으면 같은 주소의 예전 모델을 캐시에서 계속 쓰게 되므로 받지 않는다)
export const MODEL_FILES = {};

const DETECT_MAX_SIDE = 2400;   // 이보다 크면 줄여서 찾고 좌표를 되돌림
// 보내는 사진의 긴 변. 1568 → 1280: 같은 시험 사진 48장의 판독 결과가 같고(768부터 긴급을 놓침) 용량은 약 39% 줄어
// LTE 전송이 빨라진다. 서버(ai/images.py AI_MAX_SIDE 1568)는 이보다 작으면 그대로 쓴다
const OUTPUT_MAX_SIDE = 1280;
const JPEG_QUALITY = 0.88;      // 서버 images.JPEG_QUALITY
const PLATE_SIZE = 384;
// 작은 모델(t-384)은 창틀·책상·배수구 무늬를 0.18~0.53점으로 번호판이라 잡았다(번호판 없는 사진 86장).
// 한국 차 사진 속 진짜 번호판 25개는 0.72점 이상(아주 작은 뒤쪽 차 1개만 놓침). 그 사이로 정했다.
// 서버가 큰 모델(s-608, 0.15)로 한 번 더 찾아 가린다. 측정: ai/eval/privacy/device_plate_threshold.py
export const PLATE_CONF = 0.6;
const VEHICLE_CONF = 0.4;       // 서버 VEHICLE_CONF
const VEHICLE_LABELS = ["car", "bus", "truck", "motorcycle"];
const PAD = { face: 0.25, plate: 0.2, vehicle: 0.05 };
const PLATE_FILL = "#3C3C3C";

let ort, faceSession, plateSession, vehicleDetector;
let blurSupported = null;
export const status = { face: "대기", plate: "대기", vehicle: "대기", backend: "" };

// ---------------------------------------------------------------- 모델 불러오기
// opts (모두 생략 가능. 시험용 PWA는 생략)
//   manifestUrl  모델 목록 주소. 기본: 이 파일 옆 model-manifest.json. 목록 안의 상대 주소는 목록 위치 기준
//                목록 만들기: python tools/ai-verify/pwa/make_model_manifest.py <모델 폴더>
//   models       { face, plate, vehicle } 주소를 바로 넘김 (manifestUrl 대신). 주소마다 ?v=<내용 해시>
//   ortUrl       ONNX Runtime Web 1.20.1 dist 폴더 주소 (끝에 /)
//   mediapipeUrl MediaPipe Tasks Vision 0.10.14 폴더 주소 (끝에 /)
let loading = null;
export function loadModels(onChange = () => {}, opts = {}) {
  if (!loading) loading = doLoad(onChange, opts).catch((e) => { loading = null; throw e; });
  return loading;
}

async function modelList(opts) {
  if (opts.models) {
    const files = Object.fromEntries(Object.entries(opts.models).map(([k, u]) => [k, new URL(u, location.href).href]));
    // 버전 = 주소(내용 해시 포함)로 만든 해시. 모델이 바뀌면 주소의 ?v=가 바뀌어 버전도 바뀐다
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      Object.keys(files).sort().map((k) => files[k]).join("|")));
    const version = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
    return { files, version };
  }
  const listUrl = new URL(opts.manifestUrl || "./model-manifest.json", opts.manifestUrl ? location.href : import.meta.url);
  const resp = await fetch(listUrl, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`모델 목록 HTTP ${resp.status}`);
  const m = await resp.json();
  return { files: Object.fromEntries(Object.entries(m.files).map(([k, u]) => [k, new URL(u, listUrl).href])), version: m.version };
}

// 처음 열 때 받는 양이 약 20MB라 느린 회선(예: 1Mbps 데이터)에서는 몇 분 걸리고 중간에 끊기기 쉽다.
//   - 하나씩 차례로 받는다 (얼굴 → 번호판 → 차량). 동시에 받으면 셋 다 느려져 끊길 확률이 커진다.
//   - 끊기면 잠시 뒤 받은 곳부터 이어 받는다(Range). 모델은 받은 뒤 내용 해시(주소의 ?v=)를 확인한다.
//   - 다 받은 파일은 바로 캐시에 둔다. 앱을 닫았다 열어도 남은 것만 받는다.
// 셋이 모두 준비되기 전에는 촬영하지 않는다 (차량을 못 가린 사진이 생기지 않게. 원본은 붙잡아 두지 않음).
async function doLoad(onChange, opts) {
  const set = (k, v) => { status[k] = v; onChange(); };
  const ORT_URL = opts.ortUrl || ORT_BASE, MP_URL = opts.mediapipeUrl || MP_BASE;
  const list = await modelList(opts);
  for (const k of ["face", "plate", "vehicle"]) {
    if (!list.files[k]) throw new Error(`모델 주소 없음: ${k}`);
    if (!new URL(list.files[k]).searchParams.get("v")) throw new Error(`모델 주소에 내용 해시(?v=)가 없음: ${k}`);
  }
  Object.assign(MODEL_FILES, list.files);
  modelVersion = list.version;
  const sessionOpts = { executionProviders: ["wasm"] };
  const steps = [
    ["face", async (dl) => {
      if (!ort) {
        const wasm = await dl(`${ORT_URL}ort-wasm-simd-threaded.wasm`, { what: "실행기" });
        ort = await importRetry(`${ORT_URL}ort.wasm.min.mjs`, dl.onState);
        ort.env.wasm.wasmPaths = ORT_URL;
        ort.env.wasm.wasmBinary = wasm;
        // 여러 스레드는 교차 출처 격리(COOP/COEP)가 있어야 켜짐 (안내서 7장)
        ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
        status.backend = `wasm ×${ort.env.wasm.numThreads}`;
      }
      faceSession = await ort.InferenceSession.create(await dl(MODEL_FILES.face, { model: true }), sessionOpts);
    }],
    ["plate", async (dl) => {
      plateSession = await ort.InferenceSession.create(await dl(MODEL_FILES.plate, { model: true }), sessionOpts);
    }],
    ["vehicle", async (dl) => {
      const { FilesetResolver, ObjectDetector } = await importRetry(`${MP_URL}vision_bundle.mjs`, dl.onState);
      const fileset = await FilesetResolver.forVisionTasks(`${MP_URL}wasm`);
      const wasm = await dl(fileset.wasmBinaryPath, { what: "실행기" });
      fileset.wasmBinaryPath = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
      vehicleDetector = await ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: await dl(MODEL_FILES.vehicle, { model: true }), delegate: "CPU" },
        runningMode: "IMAGE", scoreThreshold: VEHICLE_CONF, maxResults: -1, categoryAllowlist: VEHICLE_LABELS,
      });
    }],
  ];
  const done = { face: () => faceSession, plate: () => plateSession, vehicle: () => vehicleDetector };
  for (const [key, step] of steps) {
    if (done[key]()) continue;                              // 다시 준비하기: 이미 된 것은 건너뜀
    const onState = (s) => set(key, s);
    const dl = Object.assign((url, o = {}) => download(url, { ...o, onState }), { onState });
    try {
      set(key, "받는 중");
      await step(dl);
      set(key, "준비");
    } catch (e) {
      set(key, "실패");
      for (const k of Object.keys(done)) if (!done[k]() && status[k] !== "실패") set(k, "대기");
      throw new Error(`모델을 불러오지 못했습니다: ${e?.message || e}`);
    }
  }
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

    // 긴 변 1,280px JPEG. 캔버스에서 만든 JPEG에는 위치·기기 정보(EXIF)가 없다
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
  const { iou, SCORE_THRESHOLD } = await import("./yunet.mjs");
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
