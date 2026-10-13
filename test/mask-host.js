// RN 시험용 앱(tools/ai-test-app)의 마스킹 엔진. 앱 안의 보이지 않는 WebView에서 열린다.
// PWA와 같은 masking.js를 쓰므로 검출·가림 결과가 PWA·서버 기준과 같다.
//
// 주고받는 메시지 (JSON 문자열)
//   앱 → 엔진  {type: "mask", id, b64, appVersion}           b64: 가리기 전 JPEG (원본)
//   엔진 → 앱  {type: "status", status, ready}               모델 준비 상태
//              {type: "masked", id, b64, report, boxes, size, timings, blur}   b64: 가린 JPEG
//              {type: "mask-error", id, name, message}
// 원본은 이 페이지에서 캔버스로만 다루고 어디에도 저장하지 않는다. 콘솔에도 찍지 않는다.
import * as masking from "./masking.js";

const post = (msg) => window.ReactNativeWebView?.postMessage(JSON.stringify(msg));
const sendStatus = () => post({ type: "status", status: { ...masking.status }, ready: masking.ready() });

async function prepare() {
  sendStatus();
  try {
    await masking.loadModels(sendStatus);
  } catch (e) {
    post({ type: "status", status: { ...masking.status }, ready: false, error: String(e?.message || e) });
    return;
  }
  sendStatus();
}

async function handle(msg) {
  if (msg.type === "status") return sendStatus();
  if (msg.type === "reload-models") return prepare();
  if (msg.type !== "mask") return;
  const { id, appVersion } = msg;
  let url = null;
  try {
    if (!masking.ready()) throw new Error("마스킹 모델이 준비되지 않았습니다");
    url = URL.createObjectURL(b64ToBlob(msg.b64, "image/jpeg"));
    msg.b64 = null;
    const img = new Image();
    img.src = url;
    await img.decode();   // 사진 정보의 회전 방향을 반영해 그린다
    const raw = document.createElement("canvas");
    raw.width = img.naturalWidth;
    raw.height = img.naturalHeight;
    raw.getContext("2d").drawImage(img, 0, 0);
    img.removeAttribute("src");
    URL.revokeObjectURL(url);
    url = null;
    const out = await masking.maskCapture(raw, appVersion);   // raw는 이 안에서 버려짐
    post({ type: "masked", id, b64: await blobToB64(out.blob), report: out.report, boxes: out.boxes,
      size: out.size, timings: out.timings, blur: out.blur, maskingVersion: masking.maskingVersion() });
  } catch (e) {
    post({ type: "mask-error", id, name: e?.name || null, message: String(e?.message || e) });
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

function onMessage(ev) {
  let msg;
  try { msg = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data; } catch { return; }
  if (msg && typeof msg === "object") handle(msg);
}
window.addEventListener("message", onMessage);     // iOS
document.addEventListener("message", onMessage);   // Android

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function blobToB64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",", 2)[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

prepare();
