// 시험용 시니어 PWA: 장소 안내 → 앱 안 카메라 촬영 → 기기 마스킹 → 대기함 저장 → 업무 API 전송 → 진행 안내.
// 앱은 AI 모듈을 부르지 않고 업무 API(/api/v1)만 부른다. 판독 결과는 어르신 화면에 보이지 않는다.
import * as masking from "./masking.js";
import * as outbox from "./outbox.js";
import * as camera from "./camera.js";

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
  $("start").disabled = $("collect").disabled = !masking.ready();
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

// 순회 정보는 화면을 열 때 미리 받아 둔다. 휴대폰에서 터널을 거치면 요청 두 번에 1~2초가 걸려
// 누른 뒤에 받으면 반응이 느려 보인다. 누르면 미리 받은 것으로 바로 보여 주고, 최신 상태는 뒤에서 다시 받는다
let patrolPrefetch = null;
const prefetchPatrol = () => (patrolPrefetch = fetchPatrol().catch(() => null));

$("start").onclick = async () => {
  // 대기 사진이 지워지지 않게 저장소 유지를 요청 (아이폰은 공간이 부족하면 지울 수 있음). 기다리지 않는다
  navigator.storage?.persist?.().catch(() => {});
  const btn = $("start"), label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "여는 중…";
  const t0 = performance.now();
  let early = null;
  try {
    early = await patrolPrefetch;
    if (early) {
      applyPatrol(early);
      openPatrol();
      // 미리 받은 뒤 바뀐 상태 반영. 그새 촬영으로 넘어갔으면 건드리지 않는다
      fetchPatrol().then((p) => { if (!$("stop").hidden) { applyPatrol(p); openPatrol(); } }).catch(() => {});
    } else {
      await loadPatrol();
      openPatrol();
    }
  } catch (e) {
    alert(`순회 정보를 받지 못했어요.
${e.message}`);
  } finally {
    btn.textContent = label;
    btn.disabled = !masking.ready();
    prefetchPatrol();   // 처음 화면으로 돌아와 다시 누를 때를 위해
  }
  const ms = Math.round(performance.now() - t0);
  if (ms > 1500) reportClientError("slow-start", new Error(`${ms}ms`), { ms, prefetched: Boolean(early) });
};

async function fetchPatrol() {
  const list = await api("GET", "/me/patrols");
  if (!list.items?.length) throw new Error("오늘 배정된 순회가 없어요.");
  return api("GET", `/patrols/${list.items[0].id}`);
}

function applyPatrol(p) {
  patrol = p;
  const first = patrol.stops.findIndex((s) => s.captureSlots.some((c) => !isResolved(c)));
  stopIdx = first < 0 ? 0 : first;
}

async function loadPatrol() {
  applyPatrol(await fetchPatrol());
}

const isResolved = (slot) => ["ACCEPTED", "REVIEW_REQUESTED"].includes(slot.captureStatus);
const allResolved = () => patrol.stops.every((s) => s.captureSlots.every(isResolved));

// 순회 시작: 모두 끝났으면 첫 장소를 다시 열지 않는다 (찍어 올려도 '이미 끝난 곳'으로 거절되기만 함)
function openPatrol() {
  if (allResolved()) return showResult("오늘 순회를 모두 마쳤어요", "더 찍을 곳이 없어요. 센터로 돌아가 주세요.", "처음으로", goHome);
  showStop();
}

function currentSlot() {
  const stop = patrol.stops[stopIdx];
  return stop.captureSlots.find((c) => !isResolved(c)) || stop.captureSlots[0];
}

function showStop() {
  const stop = patrol.stops[stopIdx];
  const slot = currentSlot();
  $("stop-step").textContent = patrol.collect ? "현장 수집" : `${stopIdx + 1} / ${patrol.stops.length} 번째 장소`;
  $("skip").textContent = patrol.collect ? "다른 시설" : "다음 장소로";
  $("stop-name").textContent = stop.name;
  $("stop-instruction").textContent = stop.instruction;
  const left = slot.retakesRemaining ?? 2;
  $("stop-slot").textContent = `찍을 모습: ${slot.label}` +
    (isResolved(slot) ? " · 이미 끝났어요" : slot.captureStatus === "RETAKE_REQUIRED" ? ` · 다시 찍기 ${left}번 남음` : "");
  // 끝난 장소는 찍지 못하게 한다. 찍어도 사진을 다 올린 뒤에야 '이미 끝난 곳'이라는 답이 온다 (LTE에서는 몇 초 낭비)
  const done = isResolved(slot);
  $("shoot").disabled = !masking.ready() || done;
  $("file-test").disabled = !masking.ready() || done;
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

$("skip").onclick = () => (patrol?.collect ? showCollectPick() : goNext(null));
$("to-home").onclick = goHome;
function goHome() { show("home"); updatePending(); showRetakeNotice(); }

// ---------------------------------------------------------------- 현장 수집 (시험용: AI 평가 사진 모으기)
// 시설 종류를 골라 계속 찍는다. 업무 규칙(재촬영 상한·끝난 장소)이 없는 시험용 순회(patrol-collect)로 보낸다.
// 찍는 방법·가리기·전송은 순회와 같다 (camera.js, outbox.js)
const COLLECT_PATROL = "patrol-collect";
$("collect").onclick = async () => {
  navigator.storage?.persist?.().catch(() => {});
  try { patrol = await api("GET", `/patrols/${COLLECT_PATROL}`); } catch (e) { return alert(`수집 정보를 받지 못했어요.\n${e.message}`); }
  showCollectPick();
};
$("collect-home").onclick = goHome;

// 이 휴대폰에서 시설별로 보낸 수 (보낸 기록 기준. 전송 대기 중인 것은 빼고 셈)
async function collectCounts() {
  const done = await outbox.results().catch(() => []);
  const n = {};
  for (const d of done) if (d.stopId?.startsWith("collect-")) n[d.stopId] = (n[d.stopId] || 0) + 1;
  return n;
}

async function showCollectPick() {
  const n = await collectCounts();
  $("collect-list").innerHTML = patrol.stops.map((s, i) =>
    `<button class="pick" data-i="${i}"><span>${escapeHtml(s.name)}</span><small>${n[s.id] || 0}장</small></button>`).join("");
  const total = Object.values(n).reduce((a, b) => a + b, 0);
  $("collect-total").textContent = `이 휴대폰에서 보낸 수집 사진 ${total}장 (전송 대기 제외)`;
  show("collect-pick");
}
$("collect-list").onclick = (e) => {
  const b = e.target.closest("button[data-i]");
  if (!b) return;
  stopIdx = +b.dataset.i;
  showStop();
};

// ---------------------------------------------------------------- 카메라 (앱 안에서만 찍음. 갤러리·기본 카메라 앱을 쓰지 않음)
// 촬영·가리기·흐림 확인은 camera.js가 한다. 여기서는 화면 전환과 시험 기록만 맡는다
async function openCamera() {
  show("camera");
  try {
    const res = await camera.open($("video"));
    $("cam-res").textContent = `${res.width}×${res.height}`;
  } catch (e) {
    show("stop");
    reportClientError("camera", e.cause || e);
    return showResult(e.message, "담당자에게 연락해 주세요.", "장소 안내로", showStop);
  }
}

$("shoot").onclick = () => { camera.unlockSound(); openCamera(); };
$("cam-cancel").onclick = () => { camera.close($("video")); showStop(); };
$("shutter").onclick = capture;

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

function getLocation() {
  if (!cfg.location || !navigator.geolocation) return Promise.resolve(null);
  // 촬영 순간 한 번만 받는다 (이동 경로를 기록하지 않음)
  return new Promise((res) => navigator.geolocation.getCurrentPosition(
    (p) => res({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
    () => res(null), { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }));
}

let pending = null;   // 확인 화면에 띄운 가린 사진 (원본 아님)

async function capture() {
  const locationP = getLocation();
  const r = await camera.capture($("video"), { appVersion: APP_VERSION, onShutter: flashScreen, onProcessing: () => show("working") });
  if (r) afterCapture(r, await locationP, "camera");
}

// camera.capture / camera.fromCanvas 결과를 확인 화면이나 전송으로 넘긴다
function afterCapture(r, location, source) {
  const fromFile = source === "file";
  const again = fromFile ? pickFile : openCamera;
  if (!r.ok) {
    const { stage, error, burst, sent } = r.info;
    const q = sent || burst;
    reportClientError(r.reason === "mask" ? "mask" : "quality-local", new Error(error || r.reason), {
      source, after: stage === "encode" ? "encode" : undefined, sharpness: q?.sharpness, brightness: q?.brightness });
    const t = camera.RETAKE_TEXT[r.reason];
    return showResult(t.title, t.sub, fromFile ? "다른 사진 고르기" : "다시 찍기", again,
      patrol?.collect ? { homeLabel: "다른 시설", home: showCollectPick } : {});
  }
  const stop = patrol.stops[stopIdx];
  const slot = currentSlot();
  const i = r.info;
  pending = {
    clientSubmissionId: crypto.randomUUID(), attemptId: crypto.randomUUID(),
    patrolId: patrol.id, stopId: stop.id, stopName: stop.name, captureSlotId: slot.id,
    capturedAt: r.capturedAt, maskingVersion: r.maskingVersion, deviceMaskReport: r.report,
    blob: r.blob, location,
    test: { boxes: i.boxes, size: i.size, timings: i.timings, blur: i.blur, source, burst: i.burst },
  };
  if (cfg.preview || fromFile) return showPreview(pending);   // 파일 시험은 항상 가린 결과를 보여 줌
  submit(pending);
}

// ---------------------------------------------------------------- 확인 화면 (시험용)
// 기기 번호판 검출 점수. 거짓 검출(창틀·책상 무늬 등)과 진짜 번호판의 점수를 모아 기준(masking.js PLATE_CONF)을 정한다
const plateScores = (boxes) => (boxes || []).filter((b) => b.kind === "plate")
  .map((b) => ({ score: b.score, box: b.box.map((v) => +v.toFixed(4)) }));
let previewUrl = null;
function showPreview(item) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(item.blob);
  $("preview-img").src = previewUrl;
  $("preview-boxes").innerHTML = cfg.boxes ? item.test.boxes.map(({ kind, score, box: [x0, y0, x1, y1] }) =>
    `<div class="bx ${kind}" style="left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%">` +
    (kind === "plate" ? `<span>${score.toFixed(2)}</span>` : "") + "</div>").join("") : "";
  const plates = plateScores(item.test.boxes);
  const r = item.deviceMaskReport, t = item.test.timings;
  $("preview-info").textContent =
    `얼굴 ${r.faces} · 번호판 ${r.plates} · 차량 ${r.vehicles}  (노랑 얼굴, 하늘 번호판, 분홍 차량)\n` +
    `촬영 ${item.test.size.captured.join("×")} → 전송 ${item.test.size.sent.join("×")}, ${(item.blob.size / 1024).toFixed(0)}KB` +
    `${item.test.blur ? "" : ", 흐림 미지원(모자이크 4칸)"}\n` +
    `처리 ${t.total}ms = 얼굴 ${t.face} + 번호판 ${t.plate} + 차량 ${t.vehicle} + 가림 ${t.mask} + JPEG ${t.encode}, 선명도 확인 ${t.check}ms` +
    (item.location ? `\n위치 ±${item.location.accuracy}m` : "") +
    (plates.length ? `\n번호판 점수: ${plates.map((p) => p.score.toFixed(2)).join(", ")} (기준 ${masking.PLATE_CONF})` : "") +
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
    // 파일 시험은 서버 기록에서 카메라 촬영과 구분되게 appVersion에 표시
    afterCapture(await camera.fromCanvas(raw, { appVersion: `${APP_VERSION}+file` }), null, "file");
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
  // 대기함에는 가린 위치(boxes) 없이 처리 시간·크기만 남긴다 (서버 기록용 시험 정보)
  const { test, ...rest } = item;
  const stored = test ? { ...rest, testInfo: { timings: test.timings, size: test.size, source: test.source, burst: test.burst,
    plateScores: plateScores(test.boxes) } } : rest;
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
  const ts = performance.now();
  const r = await outbox.send(stored, sendOpts());   // 자동 재전송과 겹치면 같은 전송 결과를 함께 받음
  activeSubmission = null;
  // 시험 기록: 보내기를 누른 뒤 결과까지 걸린 시간. 서버 기록의 처리 시간을 빼면 올리는 데 걸린 시간이 나온다
  reportClientError("send-timing", new Error(`${Math.round(performance.now() - ts)}ms`), {
    ms: Math.round(performance.now() - ts), http: r.http ?? null, bytes: stored.blob?.size, photoId: stored.clientSubmissionId });
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

  if (patrol?.collect) return collectResult(r, b);
  if (!r.done) {
    if (r.offline || r.http >= 500 || b.code === "SUBMISSION_PROCESSING") {
      return showResult("전송 대기", "연결되면 자동으로 보낼게요. 다음 장소로 가셔도 돼요.", "다음 장소로", () => goNext(null));
    }
    return showResult("보내지 못했어요", `담당자에게 알려 주세요. (${b.code || r.http})`, "장소 안내로", showStop);
  }
  if (b.code === "SLOT_RESOLVED") {   // 검토로 넘긴 구도
    return showResult("이미 끝난 곳이에요", "다음 장소로 가 주세요.", "다음 장소로", () => goNext(null));
  }
  if (b.duplicate) {                  // 이미 채택된 구도: 200 + duplicate=true (명세서 6장)
    refreshPatrol();
    return showResult("이미 끝난 곳이에요", b.message || "다음 장소로 가 주세요.", "다음 장소로", () => goNext(b.nextStopId));
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

// opts.homeLabel·opts.home: 아래 버튼 (기본 '처음으로')
function showResult(text, sub, actionLabel, action, opts = {}) {
  $("result-text").textContent = text;
  $("result-sub").textContent = sub;
  $("result-action").textContent = actionLabel;
  $("result-action").onclick = action;
  $("result-home").textContent = opts.homeLabel || "처음으로";
  $("result-home").onclick = opts.home || goHome;
  $("result-home").hidden = action === (opts.home || goHome);   // 큰 버튼이 이미 '처음으로'면 하나만
  show("result");
}

// 현장 수집 결과: 같은 시설을 계속 찍거나 다른 시설로. 판독 결과는 화면에 띄우지 않고 콘솔 기록에서 본다
async function collectResult(r, b) {
  const name = patrol.stops[stopIdx].name;
  const more = { homeLabel: "다른 시설", home: showCollectPick };
  if (!r.done) {
    if (r.offline || r.http >= 500 || b.code === "SUBMISSION_PROCESSING") {
      return showResult("전송 대기", "연결되면 자동으로 보낼게요. 계속 찍어도 돼요.", "계속 찍기", openCamera, more);
    }
    return showResult("보내지 못했어요", `(${b.code || r.http}) ${b.message || b.detail || ""}`, "계속 찍기", openCamera, more);
  }
  const n = (await collectCounts())[patrol.stops[stopIdx].id] || 0;
  const title = b.captureStatus === "RETAKE_REQUIRED" ? "흐리거나 어두워요" : "받았어요";
  showResult(title, `${name} ${n}장째 · ${b.message || ""}`, "계속 찍기", openCamera, more);
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
prefetchPatrol();
prepare();
