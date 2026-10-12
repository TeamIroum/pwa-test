// 서비스 워커: 앱 화면·마스킹 모델·검출 라이브러리만 캐시한다.
// 사진(원본·가린 사진)과 업무 API 응답은 캐시하지 않는다. 가린 사진은 IndexedDB 대기함에만 있다.
const VERSION = "pwa-test-36";
const SHELL = `shell-${VERSION}`;
const MODELS = "models-v1";        // 모델 주소에 내용 해시(?v=)가 붙어 있어 주소가 같으면 내용도 같다
const SHELL_FILES = ["./", "index.html", "app.js", "masking.js", "outbox.js", "download.js", "quality.js", "camera.js", "style.css",
  "manifest.webmanifest", "icon.svg", "yunet.mjs", "model-manifest.json", "config.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("shell-") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                      // 사진 전송(POST)은 건드리지 않음
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  // 모델과 실행기(.wasm)는 masking.js가 직접 받아 MODELS 캐시에 둔다 (진행률·이어 받기 때문에 여기서 가로채지 않음)
  const isModel = (url.origin === scope.origin && url.pathname.startsWith(`${scope.pathname}models/`)) ||
    url.hostname === "storage.googleapis.com" || url.pathname.endsWith(".wasm");
  if (isModel) return;
  if (url.hostname === "cdn.jsdelivr.net") return e.respondWith(cacheFirst(req, MODELS));
  const isShell = url.origin === scope.origin && url.pathname.startsWith(scope.pathname) &&
    !url.pathname.startsWith(`${scope.pathname}selftest/`);
  if (isShell) return e.respondWith(networkFirst(req, SHELL));
  // 그 밖(업무 API, 검증 콘솔)은 그대로 네트워크
});

async function cacheFirst(req, name) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp.ok || resp.type === "opaque") await (await caches.open(name)).put(req, resp.clone());
  return resp;
}

async function networkFirst(req, name) {
  try {
    // 브라우저 HTTP 캐시(GitHub Pages는 10분)를 건너뛰고 서버에 바뀌었는지 확인한다. 안 바뀌었으면 304라 데이터가 거의 안 듦
    const resp = await fetch(req, { cache: "no-cache" });
    if (resp.ok) (await caches.open(name)).put(req, resp.clone());
    return resp;
  } catch (err) {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}
