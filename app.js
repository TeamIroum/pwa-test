// 시험용 시니어 PWA: 장소 안내 → 앱 안 카메라 촬영 → 기기 마스킹 → 대기함 저장 → 업무 API 전송 → 진행 안내.
// 앱은 AI 모듈을 부르지 않고 업무 API(/api/v1)만 부른다. 판독 결과는 어르신 화면에 보이지 않는다.
import * as masking from "./masking.js";
import * as outbox from "./outbox.js";

const APP_VERSION = "pwa-test-0.1.0";
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 시험 설정 (사진은 넣지 않음)
const DEFAULT_API = self.PWA_CONFIG?.api || "/api/v1";   // config.js (GitHub Pages 배포본은 터널 주소)
const cfg = {
  api: DEFAULT_API, preview: true, boxes: true, location: false,
  ...safeJson(localStorage.getItem("pwa-test-cfg")),
};
function safeJson(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function saveCfg() { try { localStorage.setItem("pwa-test-cfg", JSON.stringify(cfg)); } catch { /* 저장 못 해도 동작 */ } }
const sendOpts = () => ({ apiBase: cfg.api.replace(/\/$/, "") });

$("cfg-api").value = cfg.api;
$("cfg-preview").checked = cfg.preview;
$("cfg-boxes").checked = cfg.boxes;
$("cfg-location").checked = cfg.location;
$("cfg-api").onchange = (e) => { cfg.api = e.target.value.trim() || DEFAULT_API; saveCfg(); };
for (const k of ["preview", "boxes", "location"]) $(`cfg-${k}`).onchange = (e) => { cfg[k] = e.target.checked; saveCfg(); };

// ---------------------------------------------------------------- 화면 전환
function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- 모델 준비
const MODEL_LABELS = { face: "얼굴", plate: "번호판", vehicle: "차량" };
function renderModels() {
  $("model-status").innerHTML = Object.entries(MODEL_LABELS).map(([k, label]) => {
    const st = masking.status[k];
    const cls = st === "준비" ? "st-ok" : st === "실패" ? "st-bad" : "";
    return `<li><span>${label}</span><span class="${cls}">${st}</span></li>`;
  }).join("");
  $("start").disabled = !masking.ready();
}

async function prepare() {
  $("model-retry").hidden = true;
  $("model-msg").textContent = "처음 한 번은 가림 모델을 내려받아요 (약 20MB). Wi-Fi에서 열면 빨라요. 끊겨도 이어서 받아요.";
  const t0 = performance.now();
  try {
    await masking.loadModels(renderModels);
    $("model-msg").textContent = `준비 완료 · ${Math.round(performance.now() - t0)}ms · ${masking.status.backend}`;
  } catch (e) {
    // 모델이 없으면 촬영하지 않는다 (가리지 못한 사진이 생기지 않게)
    $("model-msg").textContent = "아직 다 받지 못했어요. 받은 것은 남아 있으니 '다시 준비하기'를 눌러 주세요. 계속 안 되면 담당자에게 연락해 주세요.";
    $("model-retry").hidden = false;
    console.warn("모델 준비 실패:", e.message);
    reportClientError("model", e, { status: { ...masking.status } });
  }
  renderModels();
}
$("model-retry").onclick = prepare;

// ---------------------------------------------------------------- 순회
let patrol = null;
let stopIdx = 0;

$("start").onclick = async () => {
  // 대기 사진이 지워지지 않게 저장소 유지를 요청 (아이폰은 공간이 부족하면 지울 수 있음)
  try { await navigator.storage?.persist?.(); } catch { /* 지원 안 함 */ }
  try {
    await loadPatrol();
  } catch (e) {
    return alert(`순회 정보를 받지 못했어요.\n${e.message}`);
  }
  showStop();
};

async function loadPatrol() {
  const list = await api("GET", "/me/patrols");
  if (!list.items?.length) throw new Error("오늘 배정된 순회가 없어요.");
  patrol = await api("GET", `/patrols/${list.items[0].id}`);
  const first = patrol.stops.findIndex((s) => s.captureSlots.some((c) => !isResolved(c)));
  stopIdx = first < 0 ? 0 : first;
}

const isResolved = (slot) => ["ACCEPTED", "REVIEW_REQUESTED"].includes(slot.captureStatus);

function currentSlot() {
  const stop = patrol.stops[stopIdx];
  return stop.captureSlots.find((c) => !isResolved(c)) || stop.captureSlots[0];
}

function showStop() {
  const stop = patrol.stops[stopIdx];
  const slot = currentSlot();
  $("stop-step").textContent = `${stopIdx + 1} / ${patrol.stops.length} 번째 장소`;
  $("stop-name").textContent = stop.name;
  $("stop-instruction").textContent = stop.instruction;
  const left = slot.retakesRemaining ?? 2;
  $("stop-slot").textContent = `찍을 모습: ${slot.label}` +
    (isResolved(slot) ? " · 이미 끝났어요" : slot.captureStatus === "RETAKE_REQUIRED" ? ` · 다시 찍기 ${left}번 남음` : "");
  $("shoot").disabled = !masking.ready();
  $("file-test").disabled = !masking.ready();
  show("stop");
  showRetakeNotice();   // 촬영 중이라 미뤄 둔 '다시 찍을 곳' 알림
}

function goNext(nextStopId) {
  const i = nextStopId ? patrol.stops.findIndex((s) => s.id === nextStopId) : stopIdx + 1;
  if (i < 0 || i >= patrol.stops.length) return finish();
  stopIdx = i;
  showStop();
}

function finish() {
  showResult("모두 찍었어요", "센터로 돌아가 주세요.", "처음으로", goHome);
}

async function refreshPatrol() {
  try { patrol = await api("GET", `/patrols/${patrol.id}`); } catch { /* 연결이 없으면 지금 정보로 계속 */ }
}

$("skip").onclick = () => goNext(null);
$("to-home").onclick = goHome;
function goHome() { show("home"); updatePending(); showRetakeNotice(); }

// ---------------------------------------------------------------- 카메라 (앱 안에서만 찍음. 갤러리·기본 카메라 앱을 쓰지 않음)
let stream = null;

async function openCamera() {
  show("camera");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
  } catch (e) {
    show("stop");
    reportClientError("camera", e);
    const why = e.name === "NotAllowedError" ? "카메라 사용을 허락하지 않았어요." : "카메라를 열지 못했어요.";
    return showResult(why, "담당자에게 연락해 주세요.", "장소 안내로", showStop);
  }
  const video = $("video");
  video.srcObject = stream;
  await video.play().catch(() => {});
  const s = stream.getVideoTracks()[0].getSettings();
  $("cam-res").textContent = `${s.width || video.videoWidth}×${s.height || video.videoHeight}`;
}

function closeCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $("video").srcObject = null;
}

$("shoot").onclick = () => { unlockAudio(); openCamera(); };
$("cam-cancel").onclick = () => { closeCamera(); showStop(); };
$("shutter").onclick = capture;

// 브라우저 카메라는 촬영음이 없으므로 앱이 직접 낸다 (공개 장소 촬영 사실 알림)
// Web Audio는 아이폰 무음 스위치를 따라 소리가 꺼진다. <audio> 요소 재생은 '미디어 재생'으로 취급돼 무음 모드에서도 난다
let shutter = null;
function unlockAudio() {
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* 지원 안 함 */ }
  if (shutter) return;
  try {
    shutter = new Audio(URL.createObjectURL(shutterWav()));
    shutter.preload = "auto";
    shutter.load();
  } catch { shutter = null; /* 소리 없이 진행 */ }
}
function shutterSound() {
  unlockAudio();   // 셔터를 누른 순간(사용자 동작 안)에 재생해야 iOS가 허용한다
  if (!shutter) return;
  try {
    shutter.currentTime = 0;
    shutter.play().catch(() => {});
  } catch { /* 소리 없이 진행 */ }
}

// 촬영 순간 화면을 하얗게 한 번 번쩍인다. 소리는 휴대폰 볼륨을 따르므로 눈으로도 촬영 사실을 알린다
function flashScreen() {
  const f = $("flash");
  // 매번 새 애니메이션을 만든다. CSS 클래스를 뺐다 붙이는 방식은 아이폰 사파리에서 두 번째부터 재생되지 않을 수 있음
  if (f.animate) {
    f.getAnimations?.().forEach((a) => a.cancel());
    f.animate([{ opacity: 1 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: 600, easing: "linear" });
    return;
  }
  f.classList.remove("on");
  void f.offsetWidth;
  f.classList.add("on");
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

function getLocation() {
  if (!cfg.location || !navigator.geolocation) return Promise.resolve(null);
  // 촬영 순간 한 번만 받는다 (이동 경로를 기록하지 않음)
  return new Promise((res) => navigator.geolocation.getCurrentPosition(
    (p) => res({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
    () => res(null), { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }));
}

let pending = null;   // 확인 화면에 띄운 가린 사진 (원본 아님)

async function capture() {
  const video = $("video");
  if (!video.videoWidth) return;
  shutterSound();
  flashScreen();
  const capturedAt = new Date().toISOString();
  const raw = document.createElement("canvas");
  raw.width = video.videoWidth;
  raw.height = video.videoHeight;
  raw.getContext("2d").drawImage(video, 0, 0);   // 사진은 셔터를 누른 순간의 화면
  closeCamera();
  show("working");
  // 가리기 계산은 화면 그리기를 1~3초 막는다(아이폰 WASM). 번쩍임이 실제로 그려진 뒤에 시작해야 보인다
  await afterPaint(250);
  processRaw(raw, capturedAt, "camera");
}

function afterPaint(ms) {
  return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, ms))));
}

// raw(원본 캔버스)를 가려서 확인 화면이나 전송으로 넘긴다. raw는 maskCapture 안에서 버려진다(크기 0)
async function processRaw(raw, capturedAt, source) {
  show("working");
  const fromFile = source === "file";
  const again = fromFile ? pickFile : openCamera;
  const locationP = fromFile ? Promise.resolve(null) : getLocation();

  let masked;
  try {
    // 파일 시험은 서버 기록에서 카메라 촬영과 구분되게 appVersion에 표시
    masked = await masking.maskCapture(raw, fromFile ? `${APP_VERSION}+file` : APP_VERSION);
  } catch (e) {
    console.warn("가리기 실패:", e.message);                  // 사진 내용은 찍지 않음
    reportClientError("mask", e, { source });
    return showResult("한 번 더 찍어 주세요", "사진을 정리하지 못했어요. 계속 안 되면 담당자에게 연락해 주세요.",
      fromFile ? "다른 사진 고르기" : "다시 찍기", again);
  }
  const stop = patrol.stops[stopIdx];
  const slot = currentSlot();
  pending = {
    clientSubmissionId: crypto.randomUUID(), attemptId: crypto.randomUUID(),
    patrolId: patrol.id, stopId: stop.id, stopName: stop.name, captureSlotId: slot.id,
    capturedAt, maskingVersion: masking.maskingVersion(), deviceMaskReport: masked.report,
    blob: masked.blob, location: await locationP,
    test: { boxes: masked.boxes, size: masked.size, timings: masked.timings, blur: masked.blur, source },
  };
  if (cfg.preview || fromFile) return showPreview(pending);   // 파일 시험은 항상 가린 결과를 보여 줌
  submit(pending);
}

// ---------------------------------------------------------------- 확인 화면 (시험용)
let previewUrl = null;
function showPreview(item) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(item.blob);
  $("preview-img").src = previewUrl;
  $("preview-boxes").innerHTML = cfg.boxes ? item.test.boxes.map(({ kind, box: [x0, y0, x1, y1] }) =>
    `<div class="bx ${kind}" style="left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%"></div>`).join("") : "";
  const r = item.deviceMaskReport, t = item.test.timings;
  $("preview-info").textContent =
    `얼굴 ${r.faces} · 번호판 ${r.plates} · 차량 ${r.vehicles}  (노랑 얼굴, 하늘 번호판, 분홍 차량)\n` +
    `촬영 ${item.test.size.captured.join("×")} → 전송 ${item.test.size.sent.join("×")}, ${(item.blob.size / 1024).toFixed(0)}KB` +
    `${item.test.blur ? "" : ", 흐림 미지원(모자이크 4칸)"}\n` +
    `처리 ${t.total}ms = 얼굴 ${t.face} + 번호판 ${t.plate} + 차량 ${t.vehicle} + 가림 ${t.mask} + JPEG ${t.encode}` +
    (item.location ? `\n위치 ±${item.location.accuracy}m` : "") +
    `\n보낼 곳: ${item.stopName}${item.test.source === "file" ? " (저장된 사진 시험)" : ""}`;
  $("retake").textContent = item.test.source === "file" ? "다른 사진 고르기" : "다시 찍기";
  show("preview");
}

function dropPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  $("preview-img").removeAttribute("src");
  pending = null;
}

$("send").onclick = () => { const item = pending; dropPreview(); submit(item); };
$("retake").onclick = () => {   // 새로 찍으면 새 제출 ID
  const fromFile = pending?.test?.source === "file";
  dropPreview();
  fromFile ? pickFile() : openCamera();
};

// ---------------------------------------------------------------- 저장된 사진으로 시험 (담당자용)
// 실제 시니어 앱에는 두지 않는 기능(안내서 2장). 앱 마스킹이 잘 되는지 준비한 사진으로 확인할 때만 쓴다.
// 고른 파일도 카메라 사진과 같은 경로로 가린 뒤 보내고, 원본은 어디에도 저장하지 않는다.
function pickFile() {
  $("pick-file").value = "";
  $("pick-file").click();
}
$("file-test").onclick = pickFile;
$("pick-file").onchange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (!masking.ready()) return alert("가림 모델이 아직 준비되지 않았어요.");
  if (!patrol) {
    try { await loadPatrol(); } catch (err) { return alert(`순회 정보를 받지 못했어요.\n${err.message}`); }
  }
  show("working");
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    img.src = url;
    await img.decode();   // <img>는 사진 정보의 회전 방향을 반영해 그린다
    const raw = document.createElement("canvas");
    raw.width = img.naturalWidth;
    raw.height = img.naturalHeight;
    raw.getContext("2d").drawImage(img, 0, 0);
    processRaw(raw, new Date().toISOString(), "file");
  } catch (err) {
    reportClientError("file-open", err, { type: file.type, size: file.size });
    showResult("사진을 열지 못했어요", "JPEG나 PNG 사진을 골라 주세요.", "다른 사진 고르기", pickFile);
  } finally {
    URL.revokeObjectURL(url);
    img.removeAttribute("src");
  }
};

// ---------------------------------------------------------------- 전송
async function submit(item) {
  show("working");
  $("working-text").textContent = "사진을 보내고 있어요";
  const { test, ...stored } = item;   // 시험 정보는 대기함에 넣지 않음
  try {
    await outbox.put(stored);          // 먼저 기기에 저장한 뒤 보낸다
  } catch (e) {
    $("working-text").textContent = "얼굴과 번호판을 가리고 있어요";
    // 원인을 알 수 있게 시험 정보에 오류를 남긴다 (사진 내용은 넣지 않음)
    $("result-debug").textContent = `대기함 저장 실패: ${e?.name || ""} ${e?.message || e}
${navigator.userAgent}`;
    reportClientError("outbox-save", e, { blobSize: item.blob?.size, blobType: item.blob?.type });
    return showResult("저장하지 못했어요", "휴대폰 저장 공간을 확인하고 한 번 더 찍어 주세요.", "다시 찍기", openCamera);
  }
  activeSubmission = stored.clientSubmissionId;
  const r = await outbox.send(stored, sendOpts());   // 자동 재전송과 겹치면 같은 전송 결과를 함께 받음
  activeSubmission = null;
  $("working-text").textContent = "얼굴과 번호판을 가리고 있어요";
  updatePending();
  handleResponse(r, test);
}
let activeSubmission = null;

function handleResponse(r, test) {
  const b = r.body || {};
  const debug = { http: r.http ?? "연결 안 됨", ...b, maskTimings: test?.timings };
  $("result-debug").innerHTML = escapeHtml(JSON.stringify(debug, null, 2)) +
    (b.testConsoleRunId ? `\n\n<a href="/#run-${b.testConsoleRunId}" target="_blank">검증 콘솔에서 판독 결과 보기</a>` : "");

  if (!r.done) {
    if (r.offline || r.http >= 500 || b.code === "SUBMISSION_PROCESSING") {
      return showResult("전송 대기", "연결되면 자동으로 보낼게요. 다음 장소로 가셔도 돼요.", "다음 장소로", () => goNext(null));
    }
    return showResult("보내지 못했어요", `담당자에게 알려 주세요. (${b.code || r.http})`, "장소 안내로", showStop);
  }
  if (b.code === "SLOT_RESOLVED") {
    return showResult("이미 끝난 곳이에요", "다음 장소로 가 주세요.", "다음 장소로", () => goNext(null));
  }
  refreshPatrol();
  switch (b.nextAction) {
    case "RETAKE":
      return test?.source === "file"
        ? showResult("한 번 더 찍어 주세요", b.message || "", "다른 사진 고르기", pickFile)
        : showResult("한 번 더 찍어 주세요", b.message || "", "다시 찍기", openCamera);
    case "NEXT_STOP":
    case "NEXT_CAPTURE":
      return showResult("잘 받았어요", b.message || "", "다음 장소로", () => refreshPatrol().then(() => goNext(b.nextStopId)));
    case "RETURN_TO_CENTER":
      return showResult("모두 찍었어요", b.message || "센터로 돌아가 주세요.", "처음으로", goHome);
    default:
      return showResult("잘 받았어요", b.message || "", "다음 장소로", () => goNext(b.nextStopId));
  }
}

function showResult(text, sub, actionLabel, action) {
  $("result-text").textContent = text;
  $("result-sub").textContent = sub;
  $("result-action").textContent = actionLabel;
  $("result-action").onclick = action;
  $("result-home").onclick = goHome;
  show("result");
}

// ---------------------------------------------------------------- 대기함·기록
async function updatePending() {
  const items = await outbox.all().catch(() => []);
  $("pending").hidden = !items.length;
  $("pending").textContent = `전송 대기 ${items.length}`;
  $("pending-card").hidden = !items.length;
  $("pending-list").innerHTML = items.map((i) =>
    `<li>${escapeHtml(i.stopName)} · ${new Date(i.capturedAt).toLocaleTimeString()}` +
    (i.lastError ? ` <span class="hint">(${escapeHtml(i.lastError)}${i.permanent ? ", 자동 재전송 안 함" : ""})</span>` : "") +
    (i.permanent ? ` <button class="secondary small-btn" data-del="${escapeHtml(i.clientSubmissionId)}">지우기</button>` : "") +
    "</li>").join("");
  const done = (await outbox.results().catch(() => [])).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
  $("result-list").innerHTML = done.map((d) =>
    `<li>${escapeHtml(d.stopName)} · ${d.body.receiptStatus}/${d.body.captureStatus}` +
    (d.body.testConsoleRunId ? ` · <a href="/#run-${d.body.testConsoleRunId}" target="_blank">기록 ${d.body.testConsoleRunId}</a>` : "") +
    "</li>").join("") || "<li>없음</li>";
}

async function flushOutbox() {
  if (!navigator.onLine) return;
  const results = await outbox.flush(sendOpts()).catch(() => []);
  updatePending();
  // 전송 대기로 넘어갔던 사진이 나중에 '다시 찍기'로 판정되면 어르신에게 알린다 (지금 화면에서 보낸 사진은 이미 안내됨)
  for (const r of results || []) {
    if (r.done && r.body?.nextAction === "RETAKE" && r.item.clientSubmissionId !== activeSubmission) {
      retakeNotices.push({ stopId: r.item.stopId, stopName: r.item.stopName, message: r.body.message });
    }
  }
  showRetakeNotice();
}

// 다시 찍어야 할 곳 알림. 촬영·처리 중에는 미뤘다가 다음 화면 전환 때 보여 준다
const retakeNotices = [];
function showRetakeNotice() {
  if (!retakeNotices.length) return;
  const current = document.querySelector(".screen:not([hidden])")?.id;
  if (!["home", "stop", "result"].includes(current)) return;
  const n = retakeNotices.shift();
  showResult("다시 찍어야 할 곳이 있어요", `${n.stopName}: ${n.message || "한 번 더 찍어 주세요."}`, "그 장소로 가기", async () => {
    if (!patrol) {
      try { await loadPatrol(); } catch (e) { return alert(`순회 정보를 받지 못했어요.\n${e.message}`); }
    }
    await refreshPatrol();
    const i = patrol.stops.findIndex((st) => st.id === n.stopId);
    if (i >= 0) stopIdx = i;
    showStop();
  });
}

$("pending-list").addEventListener("click", async (e) => {
  const id = e.target?.dataset?.del;
  if (!id || !confirm("이 사진을 전송 대기에서 지울까요? 서버로 보내지 않습니다.")) return;
  await outbox.remove(id);
  updatePending();
});
$("flush").onclick = flushOutbox;
$("clear-log").onclick = async () => { await outbox.clearResults(); updatePending(); };
$("reset-slots").onclick = async () => {
  try {
    const list = await api("GET", "/me/patrols");
    await api("POST", `/patrols/${list.items[0].id}/test-reset`);
    alert("구도별 재촬영 횟수와 채택 상태를 처음으로 되돌렸습니다.");
  } catch (e) { alert(e.message); }
};

$("selftest").onclick = async () => {
  const out = $("selftest-out");
  out.hidden = false;
  out.textContent = "점검 중…";
  try {
    const r = await masking.selfTestFaces();
    out.textContent = r.lines.map((l) => `${l.ok ? "통과" : "실패"}  ${l.name}  기대 ${l.expected} / 찾음 ${l.found}  ${l.ms}ms  ${l.problems.join(", ")}`).join("\n") +
      `\n\n${r.ok ? "모두 통과 (서버와 같은 얼굴)" : "실패한 사진이 있습니다"}`;
  } catch (e) {
    out.textContent = `점검하지 못함: ${e.message}`;
  }
};

function setNet() {
  $("net").textContent = navigator.onLine ? "연결됨" : "연결 안 됨";
  $("net").className = `pill ${navigator.onLine ? "ok" : "warn"}`;
}
window.addEventListener("online", () => { setNet(); flushOutbox(); });
window.addEventListener("offline", setNet);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flushOutbox(); });

// ---------------------------------------------------------------- 도우미
// 시험용: 서버까지 가지 못한 실패를 서버에서 볼 수 있게 알린다. 사진·캔버스 내용은 넣지 않는다
async function reportClientError(stage, e, detail = null) {
  let storage = null;
  try { const est = await navigator.storage?.estimate?.(); storage = est && { usage: est.usage, quota: est.quota }; } catch { /* 없음 */ }
  try {
    await fetch(`${sendOpts().apiBase}/test-client-logs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ stage, name: e?.name || null, message: String(e?.message || e), userAgent: navigator.userAgent,
        detail: { ...detail, storage, standalone: matchMedia("(display-mode: standalone)").matches, appVersion: APP_VERSION } }),
    });
  } catch { /* 연결이 없으면 못 보냄 */ }
}

async function api(method, path) {
  const r = await fetch(`${sendOpts().apiBase}${path}`, { method, cache: "no-store" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${body.code || ""} ${body.detail || ""}`.trim());
  return body;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- 시작
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
setNet();
renderModels();
updatePending();
flushOutbox();
prepare();
