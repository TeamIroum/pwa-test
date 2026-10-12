// 촬영 직후 흐림·어두움 확인. 서버 ai/quality.py와 같은 계산이다:
//   흑백(0.299R+0.587G+0.114B)으로 바꾸고 폭 800으로 줄여, 라플라시안(4방향) 분산 = 선명도, 평균 = 밝기.
// 흐리거나 어두운 사진은 올리지 않고 바로 다시 찍게 한다 (기다림·데이터를 아낌). 최종 판단은 여전히 서버가 한다.
export const BLUR_THRESHOLD = 60;    // ai/quality.py BLUR_THRESHOLD
export const DARK_THRESHOLD = 45;    // ai/quality.py DARK_THRESHOLD
const CHECK_WIDTH = 800;             // ai/quality.py CHECK_WIDTH

let work = null;   // 재사용하는 작은 캔버스 (원본 내용은 계산 뒤 지움)

// source: 캔버스나 video. 돌려주는 것: { sharpness, brightness }
export function measure(source) {
  const W = source.videoWidth || source.width, H = source.videoHeight || source.height;
  const w = Math.min(W, CHECK_WIDTH), h = Math.max(1, Math.round((H * w) / W));
  work ||= document.createElement("canvas");
  work.width = w; work.height = h;
  const ctx = work.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  ctx.clearRect(0, 0, w, h);

  const g = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    const v = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
    g[j] = v; sum += v;
  }
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

// 서버와 같은 순서: 어두우면 어두움(어두운 사진은 원래 분산이 낮음), 아니면 흐림. 괜찮으면 null
export function problem({ sharpness, brightness }) {
  if (brightness < DARK_THRESHOLD) return "dark";
  if (sharpness < BLUR_THRESHOLD) return "blur";
  return null;
}
