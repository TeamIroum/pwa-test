// 전송 대기함 (IndexedDB). 가린 사진만 넣는다. 원본은 어떤 경로로도 여기에 오지 않는다.
//
// 업무 API 명세 6·7절
//   - 먼저 대기함에 영속 저장한 뒤 보낸다. 서버가 RECEIVED 또는 NO_MEDIA로 답하기 전에는 "전송 대기"로 둔다.
//   - 503·연결 끊김은 접수가 아니다. 같은 clientSubmissionId/attemptId·같은 파일로 다시 보낸다.
//   - 앱을 다시 열 때, 연결이 돌아올 때 대기 사진을 보낸다 (백그라운드 전송에 기대지 않음).
const DB_NAME = "pwa-test-outbox";
const STORE = "outbox";
const LOG = "results";

let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "clientSubmissionId" });
        req.result.createObjectStore(LOG, { keyPath: "clientSubmissionId" });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("저장소 작업 취소"));
  });
}

// 사진은 Blob이 아니라 바이트(ArrayBuffer)로 넣는다. 아이폰 사파리는 IndexedDB에 Blob을 넣다 실패하는 경우가 있다
export async function put(item) {
  const { blob, ...rest } = item;
  const row = blob ? { ...rest, bytes: await blob.arrayBuffer(), type: blob.type || "image/jpeg" } : rest;
  return tx(STORE, "readwrite", (s) => s.put(row));
}
const photo = (item) => item.blob || new Blob([item.bytes], { type: item.type || "image/jpeg" });
export const remove = (id) => tx(STORE, "readwrite", (s) => s.delete(id));
export const all = () => tx(STORE, "readonly", (s) => s.getAll());
export const count = () => tx(STORE, "readonly", (s) => s.count());
export const results = () => tx(LOG, "readonly", (s) => s.getAll());
const logResult = (r) => tx(LOG, "readwrite", (s) => s.put(r));
export const clearResults = () => tx(LOG, "readwrite", (s) => s.clear());

// 한 건 보내기. 돌려주는 것: { done: 대기함에서 뺐는지, http, body, offline }
// 같은 사진을 동시에 두 번 보내지 않는다: 이미 보내는 중이면 그 결과를 함께 기다린다 (전송 버튼과 자동 재전송이 겹칠 때)
const inflight = new Map();
export function send(item, opts) {
  const id = item.clientSubmissionId;
  if (!inflight.has(id)) inflight.set(id, sendOnce(item, opts).finally(() => inflight.delete(id)));
  return inflight.get(id);
}

async function sendOnce(item, { apiBase }) {
  const fd = new FormData();
  fd.append("file", photo(item), `${item.clientSubmissionId}.jpg`);
  for (const k of ["clientSubmissionId", "captureSlotId", "attemptId", "capturedAt", "maskingVersion"]) fd.append(k, item[k]);
  fd.append("deviceMasked", "true");
  fd.append("deviceMaskReport", JSON.stringify(item.deviceMaskReport));
  if (item.location) {
    fd.append("latitude", item.location.latitude);
    fd.append("longitude", item.location.longitude);
    fd.append("locationAccuracyMeters", item.location.accuracy);
  }
  let resp;
  try {
    resp = await fetch(`${apiBase}/patrols/${item.patrolId}/stops/${item.stopId}/inspections`,
      { method: "POST", body: fd, cache: "no-store" });
  } catch {
    await keep(item, { lastError: "연결 안 됨" });
    return { done: false, offline: true };
  }
  const body = await resp.json().catch(() => ({}));
  const receipt = body.receiptStatus;
  // 접수(RECEIVED)·사진 없는 품질 실패(NO_MEDIA)·이미 끝난 구도(SLOT_RESOLVED)는 최종 답이므로 대기함에서 뺀다
  const final = (resp.ok && (receipt === "RECEIVED" || receipt === "NO_MEDIA")) || body.code === "SLOT_RESOLVED";
  if (final) {
    await logResult({ clientSubmissionId: item.clientSubmissionId, stopId: item.stopId, stopName: item.stopName,
      capturedAt: item.capturedAt, http: resp.status, body, at: new Date().toISOString() });
    await remove(item.clientSubmissionId);
    return { done: true, http: resp.status, body };
  }
  // 그 밖(503, 409 처리 중, 4xx 형식 오류)은 남겨 두고 이유를 적는다. 4xx 형식 오류는 자동으로 다시 보내지 않음(지우기 가능)
  const permanent = resp.status >= 400 && resp.status < 500 && body.code !== "SUBMISSION_PROCESSING";
  await keep(item, { lastError: `${resp.status} ${body.code || ""} ${body.detail || ""}`.trim(), permanent });
  return { done: false, http: resp.status, body };
}

// 실패 이유를 적어 다시 저장. 그사이 다른 경로가 이미 지웠으면 되살리지 않는다
async function keep(item, patch) {
  const cur = await tx(STORE, "readonly", (s) => s.get(item.clientSubmissionId));
  if (!cur) return;
  await tx(STORE, "readwrite", (s) => s.put({ ...cur, ...patch, tries: (cur.tries || 0) + 1 }));
}

let flushing = null;
export function flush(opts) {
  if (!flushing) {
    flushing = (async () => {
      const out = [];
      for (const item of await all()) {
        if (item.permanent) continue;
        const r = await send(item, opts);
        out.push({ item, ...r });
        if (r.offline) break;    // 연결이 없으면 나머지도 실패하므로 멈춤
      }
      return out;
    })().finally(() => { flushing = null; });
  }
  return flushing;
}
