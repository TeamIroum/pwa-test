// 서비스 워커: 앱 화면·마스킹 모델·검출 라이브러리만 캐시한다.
// 사진(원본·가린 사진)과 업무 API 응답은 캐시하지 않는다. 가린 사진은 IndexedDB 대기함에만 있다.
const VERSION = "pwa-test-17";
const SHELL = `shell-${VERSION}`;
const MODELS = "models-v1";        // 모델 주소에 내용 해시(?v=)가 붙어 있어 주소가 같으면 내용도 같다
const SHELL_FILES = ["./", "index.html", "app.js", "masking.js", "outbox.js", "style.css",
  "manifest.webmanifest", "icon.svg", "lib/yunet.mjs", "model-manifest.json", "config.js"];

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
  const isLib = url.hostname === "cdn.jsdelivr.net";
  const isModel = (url.origin === scope.origin && url.pathname.startsWith(`${scope.pathname}models/`)) ||
    url.hostname === "storage.googleapis.com";           // 원본에서 바로 받는 모델 (검증 콘솔 PWA_MODEL_ORIGINS)
  if (isModel) return e.respondWith(cacheFirst(req, MODELS, true));
  if (isLib) return e.respondWith(cacheFirst(req, MODELS));
  const isShell = url.origin === scope.origin && url.pathname.startsWith(scope.pathname) &&
    !url.pathname.startsWith(`${scope.pathname}selftest/`);
  if (isShell) return e.respondWith(networkFirst(req, SHELL));
  // 그 밖(업무 API, 검증 콘솔)은 그대로 네트워크
});

async function cacheFirst(req, name, dropOldVersions = false) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp.ok || resp.type === "opaque") {
    const cache = await caches.open(name);
    if (dropOldVersions) {
      // 같은 모델 파일의 예전 해시(?v=) 캐시를 지운다
      const path = new URL(req.url).pathname;
      for (const old of await cache.keys()) {
        if (new URL(old.url).pathname === path && old.url !== req.url) await cache.delete(old);
      }
    }
    await cache.put(req, resp.clone());
  }
  return resp;
}

async function networkFirst(req, name) {
  try {
    const resp = await fetch(req);
    if (resp.ok) (await caches.open(name)).put(req, resp.clone());
    return resp;
  } catch (err) {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}
