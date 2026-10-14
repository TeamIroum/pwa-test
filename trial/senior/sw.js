// 시니어 앱 서비스 워커 (기능정의서 SYN-03 일부): 연결이 끊겨도 앱 화면이 열리게 앱 파일만 휴대폰에 저장한다.
// - 화면(index.html): 항상 서버 것을 먼저 받고, 연결이 없을 때만 저장본을 쓴다 → 새로 배포하면 바로 새 화면
// - 이름에 해시가 붙은 파일(/assets/*)·아이콘·manifest: 저장본을 먼저 쓴다 (이름이 바뀌면 새 파일)
// - 업무 API(/api/*)·사진은 저장하지 않는다 (로그인 정보·개인정보 사진을 기기에 남기지 않음)
// - 가림 모델(/models/*)은 masking/download.js가 따로 저장한다
const CACHE = 'senior-shell-v1'

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon-192.png'])).catch(() => {}))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('senior-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/models/')) return
  if (req.mode === 'navigate') {
    // 화면: 서버 먼저, 연결이 없을 때만 저장본
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put('/', res.clone()))
          return res
        })
        .catch(() => caches.match('/').then((r) => r || Response.error())),
    )
    return
  }
  if (url.pathname.startsWith('/assets/') || /\.(png|svg|webmanifest)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()))
            return res
          }),
      ),
    )
  }
})
