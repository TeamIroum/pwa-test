// YuNet 얼굴 검출 (브라우저용). yunet_reference.py를 그대로 옮긴 것입니다.
//
// 사용 (브라우저, onnxruntime-web):
//   import * as ort from "onnxruntime-web";
//   import { loadYuNet, detectFaces } from "./yunet.mjs";
//   const session = await loadYuNet(ort, "/models/face_yunet_s_dynamic@1.onnx");
//   const ctx = canvas.getContext("2d");
//   const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
//   const faces = await detectFaces(ort, session, img.data, img.width, img.height);
//   // faces: [{x, y, w, h, landmarks: [10개], score}]  원본 픽셀 좌표
//
// 서버와 같은 결과를 내기 위한 조건
//   - 사진을 줄이지 않고 원본 해상도로 넣는다 (긴 변 2,400px 초과면 그 크기로 줄인 뒤 좌표를 되돌림)
//   - 입력은 BGR 순서, 0~255 실수 그대로, 오른쪽·아래를 0으로 채워 32의 배수로 맞춤
//   - 점수 기준 0.55, NMS 0.3 (서버 FACE_SCORE와 같음)

export const SCORE_THRESHOLD = 0.55;
export const NMS_THRESHOLD = 0.3;
export const TOP_K = 5000;
const STRIDES = [8, 16, 32];

export async function loadYuNet(ort, modelUrl, options = {}) {
  return ort.InferenceSession.create(modelUrl, options);
}

// rgba: Uint8ClampedArray/Uint8Array (canvas ImageData.data), 길이 width*height*4
export function preprocess(rgba, width, height) {
  const padW = Math.ceil(width / 32) * 32;
  const padH = Math.ceil(height / 32) * 32;
  const plane = padW * padH;
  const data = new Float32Array(3 * plane); // 채워지지 않은 부분은 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * padW + x;
      data[dst] = rgba[src + 2];             // B
      data[plane + dst] = rgba[src + 1];     // G
      data[2 * plane + dst] = rgba[src];     // R
    }
  }
  return { data, padW, padH };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// outputs: { cls_8: Float32Array, obj_8: ..., bbox_8: ..., kps_8: ..., ... }
export function decode(outputs, padW, padH, scoreThreshold = SCORE_THRESHOLD) {
  const faces = [];
  for (const s of STRIDES) {
    const cols = padW / s;
    const rows = padH / s;
    const cls = outputs[`cls_${s}`];
    const obj = outputs[`obj_${s}`];
    const bbox = outputs[`bbox_${s}`];
    const kps = outputs[`kps_${s}`];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
        if (score < scoreThreshold) continue;
        const cx = (c + bbox[i * 4]) * s;
        const cy = (r + bbox[i * 4 + 1]) * s;
        const w = Math.exp(bbox[i * 4 + 2]) * s;
        const h = Math.exp(bbox[i * 4 + 3]) * s;
        const landmarks = [];
        for (let n = 0; n < 5; n++) {
          landmarks.push((kps[i * 10 + 2 * n] + c) * s, (kps[i * 10 + 2 * n + 1] + r) * s);
        }
        faces.push({ x: cx - w / 2, y: cy - h / 2, w, h, landmarks, score });
      }
    }
  }
  return nms(faces);
}

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export function nms(faces, threshold = NMS_THRESHOLD, topK = TOP_K) {
  const sorted = [...faces].sort((a, b) => b.score - a.score).slice(0, topK);
  const keep = [];
  for (const f of sorted) {
    if (keep.every((k) => iou(f, k) <= threshold)) keep.push(f);
  }
  return keep;
}

export async function detectFaces(ort, session, rgba, width, height) {
  const { data, padW, padH } = preprocess(rgba, width, height);
  const input = new ort.Tensor("float32", data, [1, 3, padH, padW]);
  const result = await session.run({ input });
  const outputs = {};
  for (const name of Object.keys(result)) outputs[name] = result[name].data;
  return decode(outputs, padW, padH);
}
