// 앱 안 카메라 촬영: 카메라 열기 → 셔터(촬영음) → 연속 장면 중 가장 선명한 것 → 흐림·어두움 확인
//   → 얼굴·번호판·차량 가리기 → 보낼 JPEG로 한 번 더 확인.
// 화면(DOM 구조·React)과 상관없이 <video> 요소만 받는다. 시니어 앱은 이 파일과 masking.js·quality.js·
// download.js·outbox.js를 그대로 가져가 화면에서 open/capture만 부르면 된다 (docs/시니어앱_촬영기능_적용요청.md).
// 원본은 이 파일 밖으로 나가지 않는다: 고르지 않은 장면·원본 캔버스는 바로 크기 0으로 지운다.
import * as quality from "./quality.js";
import * as masking from "./masking.js";

// 사진은 카메라 영상에서 떼어 온 장면이라 셔터를 누르는 순간의 흔들림이 그대로 찍힌다.
// 누른 뒤 약 0.3초 동안 몇 장면을 떼어 가장 선명한 것을 쓴다 (서버와 같은 선명도 계산, quality.js)
const BURST_FRAMES = 5;
const BURST_GAP_MS = 70;
// 가리기 계산은 화면 그리기를 1~3초 막는다(아이폰 WASM). 셔터 효과·'가리는 중' 화면이 그려진 뒤에 시작한다
const PAINT_WAIT_MS = 250;

// 어르신 화면 문구. reason → { title, sub }
export const RETAKE_TEXT = {
  blur: { title: "사진이 흐려요", sub: "휴대폰을 잠깐 멈추고 한 번 더 찍어 주세요." },
  dark: { title: "사진이 어두워요", sub: "밝은 쪽에서 다시 찍어 주세요." },
  mask: { title: "한 번 더 찍어 주세요", sub: "사진을 정리하지 못했어요. 계속 안 되면 담당자에게 연락해 주세요." },
};

// ---------------------------------------------------------------- 카메라 열고 닫기
export class CameraError extends Error {
  // reason: "denied"(권한 거부) | "unavailable"(카메라 없음·사용 중 등)
  constructor(reason, cause) {
    super(reason === "denied" ? "카메라 사용을 허락하지 않았어요." : "카메라를 열지 못했어요.");
    this.name = "CameraError";
    this.reason = reason;
    this.cause = cause;
  }
}

// 후면 카메라를 video에 띄운다. 돌려주는 것: 실제로 받은 해상도 { width, height }
// 실패하면 CameraError. 카메라는 HTTPS(개발 중에는 localhost)에서만 열린다
export async function open(video) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
  } catch (e) {
    throw new CameraError(e?.name === "NotAllowedError" ? "denied" : "unavailable", e);
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  const s = stream.getVideoTracks()[0].getSettings();
  return { width: s.width || video.videoWidth, height: s.height || video.videoHeight };
}

export function close(video) {
  video.srcObject?.getTracks?.().forEach((t) => t.stop());
  video.srcObject = null;
}

// ---------------------------------------------------------------- 촬영
// 셔터를 누른 버튼의 클릭 처리 안에서 바로 부른다 (아이폰은 사용자 동작 안에서만 소리를 낸다).
// opts.appVersion: 서버에 보고할 앱 버전 / opts.onShutter(): 촬영음 직후 (화면 번쩍임 등)
// opts.onProcessing(): 장면을 고른 뒤 가리기 전에 (화면을 '가리는 중'으로). 카메라는 그 전에 닫는다
// 돌려주는 것
//   { ok: true, blob, report, maskingVersion, capturedAt, info }   blob = 가린 JPEG, report = deviceMaskReport
//   { ok: false, reason: "blur" | "dark" | "mask", info }          RETAKE_TEXT[reason]로 안내하고 다시 찍게 한다
//   null                                                          카메라 영상이 아직 없음 (무시)
// info는 시험 기록용(고른 장면, 선명도, 처리 시간, 가린 위치)이며 사진 내용은 없다
export async function capture(video, opts = {}) {
  if (!video.videoWidth) return null;
  shutterSound();
  opts.onShutter?.();
  const capturedAt = new Date().toISOString();
  let raw = null, spare = null, best = null;
  for (let i = 0; i < BURST_FRAMES; i++) {
    if (i) await new Promise((r) => setTimeout(r, BURST_GAP_MS));
    const c = spare || document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    const q = quality.measure(c);
    if (!best || q.sharpness > best.sharpness) { spare = raw; raw = c; best = { ...q, frame: i }; } else spare = c;
  }
  if (spare) spare.width = spare.height = 0;   // 고르지 않은 장면은 바로 버린다
  close(video);
  const burst = { frames: BURST_FRAMES, picked: best.frame, sharpness: round1(best.sharpness), brightness: round1(best.brightness) };

  // 확실히 흐리거나 어두우면 올리지 않고 바로 다시 찍게 한다 (서버도 같은 기준으로 거절하므로 기다림·데이터만 아낌)
  const bad = quality.problem(best);
  if (bad) {
    raw.width = raw.height = 0;
    return { ok: false, reason: bad, info: { stage: "frame", burst } };
  }
  opts.onProcessing?.();
  await afterPaint(PAINT_WAIT_MS);
  return finish(raw, capturedAt, opts.appVersion, burst);
}

// 저장된 사진으로 시험할 때 (담당자용, 실제 시니어 앱에는 두지 않음). raw: 원본 캔버스. 결과는 capture와 같다
export async function fromCanvas(raw, opts = {}) {
  return finish(raw, new Date().toISOString(), opts.appVersion, null);
}

// raw(원본 캔버스)를 가리고 보낼 JPEG로 다시 잰다. raw는 maskCapture 안에서 버려진다(크기 0)
async function finish(raw, capturedAt, appVersion, burst) {
  let masked;
  try {
    masked = await masking.maskCapture(raw, appVersion);
  } catch (e) {
    return { ok: false, reason: "mask", info: { stage: "mask", burst, error: `${e?.name || "Error"}: ${e?.message || e}` } };
  }
  // 서버는 가리고 압축한 JPEG로 선명도를 잰다. 압축하면 값이 내려가므로 보낼 사진으로 한 번 더 잰다 (서버와 같은 판정)
  const tq = performance.now();
  const sent = await measureBlob(masked.blob);
  masked.timings.check = Math.round(performance.now() - tq);
  if (burst) Object.assign(burst, { sentSharpness: round1(sent.sharpness), sentSharpnessFast: round1(sent.fast) });
  const info = { burst, boxes: masked.boxes, size: masked.size, timings: masked.timings, blur: masked.blur,
    sent: { sharpness: round1(sent.sharpness), brightness: round1(sent.brightness) } };
  const bad = quality.problem(sent);
  if (bad) return { ok: false, reason: bad, info: { ...info, stage: "encode" } };
  return { ok: true, blob: masked.blob, report: masked.report, maskingVersion: masking.maskingVersion(), capturedAt, info };
}

async function measureBlob(blob) {
  const bmp = await createImageBitmap(blob);
  // fast는 시험 기록용: 브라우저 줄이기 값과 비교해 기기 차이를 본다
  try { return { ...quality.measure(bmp, { exact: true }), fast: quality.measure(bmp).sharpness }; } finally { bmp.close(); }
}

function afterPaint(ms) {
  return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, ms))));
}

const round1 = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------- 촬영음
// 브라우저 카메라는 촬영음이 없으므로 앱이 직접 낸다 (공개 장소 촬영 사실 알림)
// Web Audio는 아이폰 무음 스위치를 따라 소리가 꺼진다. <audio> 요소 재생은 '미디어 재생'으로 취급돼 무음 모드에서도 난다
let shutter = null;

// 카메라를 여는 버튼의 클릭 처리 안에서 한 번 부른다 (아이폰은 사용자 동작 안에서 준비한 소리만 재생)
export function unlockSound() {
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* 지원 안 함 */ }
  if (shutter) return;
  try {
    shutter = new Audio(URL.createObjectURL(shutterWav()));
    shutter.preload = "auto";
    shutter.load();
  } catch { shutter = null; /* 소리 없이 진행 */ }
}

function shutterSound() {
  unlockSound();
  if (!shutter) return;
  try {
    shutter.currentTime = 0;
    shutter.play().catch(() => {});
  } catch { /* 소리 없이 진행 */ }
}

// 카메라 셔터 "찰-칵"을 WAV로 만든다. 파일을 따로 두지 않으려고 코드로 생성
//   찰: 셔터가 열리는 날카로운 딸깍 / 칵: 약 70ms 뒤 닫히는 조금 낮고 묵직한 딸깍
//   딸깍 하나 = 대역 필터를 거친 잡음(마찰) + 짧은 금속 울림 + 낮은 툭(몸체)
function shutterWav() {
  const rate = 44100, n = Math.floor(rate * 0.2);
  const s = new Float32Array(n);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;   // 매번 같은 소리

  function click(at, amp, center, decay, ring, thump) {
    // 2차 대역 통과 필터 (RBJ biquad)
    const w = (2 * Math.PI * center) / rate, q = 1.4, alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
    const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const start = Math.floor(at * rate);
    for (let i = start; i < n; i++) {
      const t = (i - start) / rate;
      if (t > 0.08) break;
      const x = rand();
      const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const attack = Math.min(1, t / 0.0004);                                   // 0.4ms 만에 올라옴
      s[i] += amp * attack * (
        2.2 * y * Math.exp(-t / decay) +                                        // 마찰음
        0.35 * Math.sin(2 * Math.PI * ring * t) * Math.exp(-t / (decay * 2.5)) + // 금속 울림
        0.6 * Math.sin(2 * Math.PI * thump * t) * Math.exp(-t / 0.012));       // 몸체 툭
    }
  }
  click(0.000, 1.0, 4200, 0.0035, 2900, 190);   // 찰
  click(0.068, 0.85, 3000, 0.0050, 2100, 140);  // 칵

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(s[i]));
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) view.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); view.setUint32(4, 36 + n * 2, true); str(8, "WAVE");
  str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, (s[i] / peak) * 0.95 * 0x7fff, true);   // 최대 음량으로 맞춤
  return new Blob([view], { type: "audio/wav" });
}
