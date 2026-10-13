// 촬영 직후 흐림·어두움 확인. 서버 ai/quality.py와 같은 계산이다:
//   흑백(0.299R+0.587G+0.114B)으로 바꾸고 폭 800으로 줄여, 라플라시안(4방향) 분산 = 선명도, 평균 = 밝기.
// 흐리거나 어두운 사진은 올리지 않고 바로 다시 찍게 한다 (기다림·데이터를 아낌). 최종 판단은 여전히 서버가 한다.
export const BLUR_THRESHOLD = 60;    // ai/quality.py BLUR_THRESHOLD
export const DARK_THRESHOLD = 45;    // ai/quality.py DARK_THRESHOLD
const CHECK_WIDTH = 800;             // ai/quality.py CHECK_WIDTH

let work = null;   // 재사용하는 캔버스 (원본 내용은 계산 뒤 지우고 크기 0으로)

// source: 캔버스·video·ImageBitmap. 돌려주는 것: { sharpness, brightness }
// exact=false: 줄이기를 브라우저에 맡긴다 (빠름. 연속 장면 중 고르기처럼 서로 비교만 할 때)
// exact=true: 원래 크기로 읽어 OpenCV cv2.resize(INTER_LINEAR)와 같은 방식으로 직접 줄인다.
//   브라우저마다 줄이는 방식이 달라 아이폰 사파리는 서버보다 약 15% 높게 나왔다. 보낼 사진의 판정에 쓴다
export function measure(source, { exact = false } = {}) {
  const W = source.videoWidth || source.width, H = source.videoHeight || source.height;
  const full = exact && W > CHECK_WIDTH;
  const rw = full ? W : Math.min(W, CHECK_WIDTH), rh = full ? H : Math.max(1, Math.round((H * rw) / W));
  work ||= document.createElement("canvas");
  work.width = rw; work.height = rh;
  const ctx = work.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, rw, rh);
  const px = ctx.getImageData(0, 0, rw, rh).data;
  ctx.clearRect(0, 0, rw, rh);
  work.width = work.height = 0;

  const gray = new Uint8Array(rw * rh);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
  let g = gray, w = rw, h = rh;
  if (full) {
    w = CHECK_WIDTH; h = Math.max(1, Math.floor((H * CHECK_WIDTH) / W));   // 서버: int(h * 800 / w)
    g = resizeLinear(gray, W, H, w, h);
  }

  let sum = 0;
  for (let j = 0; j < g.length; j++) sum += g[j];
  // 가장자리는 OpenCV 기본(BORDER_REFLECT_101)처럼 안쪽 값을 비춰 쓴다
  const at = (x, y) => g[(y < 0 ? -y : y >= h ? 2 * h - 2 - y : y) * w + (x < 0 ? -x : x >= w ? 2 * w - 2 - x : x)];
  let s1 = 0, s2 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) - 4 * g[y * w + x];
      s1 += l; s2 += l * l;
    }
  }
  const n = w * h;
  return { sharpness: s2 / n - (s1 / n) ** 2, brightness: sum / n };
}

// cv2.resize INTER_LINEAR (8비트): 픽셀 중심 맞춤, 가장자리 고정, 가중치 11비트 고정소수점
function resizeLinear(src, sw, sh, dw, dh) {
  const R = 2048;
  const axis = (dn, sn) => {
    const i0 = new Int32Array(dn), i1 = new Int32Array(dn), a = new Int32Array(dn);
    const scale = sn / dn;
    for (let d = 0; d < dn; d++) {
      let f = (d + 0.5) * scale - 0.5, s = Math.floor(f);
      f -= s;
      if (s < 0) { s = 0; f = 0; }
      if (s >= sn - 1) { s = sn - 1; f = 0; }
      i0[d] = s; i1[d] = Math.min(s + 1, sn - 1);
      a[d] = Math.round(f * R);
    }
    return { i0, i1, a };
  };
  const X = axis(dw, sw), Y = axis(dh, sh);
  const out = new Uint8Array(dw * dh);
  const r0 = new Int32Array(dw), r1 = new Int32Array(dw);
  const row = (y, buf) => {
    const o = y * sw;
    for (let x = 0; x < dw; x++) buf[x] = src[o + X.i0[x]] * (R - X.a[x]) + src[o + X.i1[x]] * X.a[x];
  };
  for (let y = 0; y < dh; y++) {
    row(Y.i0[y], r0); row(Y.i1[y], r1);
    const b = Y.a[y];
    for (let x = 0; x < dw; x++) {
      // OpenCV: (((b0*(r0>>4))>>16) + ((b1*(r1>>4))>>16) + 2) >> 2
      out[y * dw + x] = (((((R - b) * (r0[x] >> 4)) >> 16) + ((b * (r1[x] >> 4)) >> 16) + 2) >> 2);
    }
  }
  return out;
}

// 서버와 같은 순서: 어두우면 어두움(어두운 사진은 원래 분산이 낮음), 아니면 흐림. 괜찮으면 null
export function problem({ sharpness, brightness }) {
  if (brightness < DARK_THRESHOLD) return "dark";
  if (sharpness < BLUR_THRESHOLD) return "blur";
  return null;
}
