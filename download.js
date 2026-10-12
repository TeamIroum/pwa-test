// 느린 회선(예: 1Mbps 데이터)에서 모델·실행기를 끝까지 받기 위한 내려받기. masking.js가 쓴다.
//   - 끊기면 잠시 뒤 다시 받는다. 모델(주소에 ?v=내용 해시)은 받은 곳부터 이어 받고(Range), 다 받은 뒤 해시를 확인한다.
//   - 다 받은 파일은 캐시(models-v1)에 둔다. 앱을 닫았다 열어도 남은 것만 받는다.
const DL_CACHE = "models-v1";                               // sw.js의 MODELS와 같은 캐시
const RETRY_WAIT_S = [2, 5, 10, 20, 30, 30, 30, 30];       // 끊기면 기다렸다 이어 받음 (모두 합쳐 약 2분 반)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function download(url, { model = false, what = "", onState = () => {} }) {
  const cache = self.caches ? await caches.open(DL_CACHE).catch(() => null) : null;
  const hit = cache && await cache.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  // 이어 받기는 모델만: 받은 뒤 해시로 확인할 수 있어서 (CDN이 압축해 보내면 이어 붙인 결과가 틀릴 수 있음)
  const expect = model ? new URL(url).searchParams.get("v") : null;
  let parts = [], got = 0, total = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const resume = Boolean(expect) && got > 0;
      const resp = await fetch(url, { cache: "no-store", headers: resume ? { Range: `bytes=${got}-` } : {} });
      if (resp.status !== 206 || !resume) {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        parts = []; got = 0;                                // 처음부터 (이어 받기를 안 받아 준 경우 포함)
        total = Number(resp.headers.get("content-length")) || 0;
      }
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got += value.length;
        // 압축 전송이면 받은 양이 content-length를 넘을 수 있어 99%에서 멈춰 둔다
        onState(`${what ? what + " " : ""}받는 중 ${total ? Math.min(99, Math.floor((got * 100) / total)) : "…"}${total ? "%" : ""}`);
      }
      const buf = new Uint8Array(got);
      let at = 0;
      for (const p of parts) { buf.set(p, at); at += p.length; }
      if (expect && self.crypto?.subtle && (await sha256Hex(buf)).slice(0, expect.length) !== expect) {  // https에서만 확인 가능
        parts = []; got = 0;
        throw new Error("내용 확인 실패");
      }
      if (cache) {
        await cache.put(url, new Response(buf)).catch(() => {});
        // 같은 파일의 예전 버전(?v=)은 지운다
        const path = new URL(url).pathname;
        for (const old of await cache.keys()) if (new URL(old.url).pathname === path && old.url !== url) await cache.delete(old);
      }
      return buf;
    } catch (e) {
      if (attempt >= RETRY_WAIT_S.length) throw e;
      const wait = RETRY_WAIT_S[attempt];
      for (let s = wait; s > 0; s--) {
        onState(`연결이 끊겨 ${s}초 뒤 ${got ? "이어" : "다시"} 받아요 (${attempt + 1}/${RETRY_WAIT_S.length})`);
        await sleep(1000);
      }
    }
  }
}

// 실패한 import는 브라우저가 기억해 같은 주소로는 다시 불러오지 못한다. 다시 할 때는 주소 뒤에 ?r=n을 붙인다
export async function importRetry(url, onState) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await import(/* @vite-ignore */ attempt ? `${url}?r=${attempt}` : url);   // 시니어 앱(Vite)이 묶지 않게
    } catch (e) {
      if (attempt >= RETRY_WAIT_S.length) throw e;
      for (let s = RETRY_WAIT_S[attempt]; s > 0; s--) {
        onState(`연결이 끊겨 ${s}초 뒤 다시 받아요 (${attempt + 1}/${RETRY_WAIT_S.length})`);
        await sleep(1000);
      }
    }
  }
}

async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
