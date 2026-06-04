import { Affine, IDENTITY, Point, Rect, TrackMode } from './types';

/** Compose two affines: returns B ∘ A (apply A first, then B). */
export function compose(A: Affine, B: Affine): Affine {
  const [a1, b1, t1x, c1, d1, t1y] = A;
  const [a2, b2, t2x, c2, d2, t2y] = B;
  return [
    a2 * a1 + b2 * c1,
    a2 * b1 + b2 * d1,
    a2 * t1x + b2 * t1y + t2x,
    c2 * a1 + d2 * c1,
    c2 * b1 + d2 * d1,
    c2 * t1x + d2 * t1y + t2y,
  ];
}

export function applyAffine(m: Affine, p: Point): Point {
  return {
    x: m[0] * p.x + m[1] * p.y + m[2],
    y: m[3] * p.x + m[4] * p.y + m[5],
  };
}

/** Invert a 2x3 affine. Returns identity if singular. */
export function invertAffine(m: Affine): Affine {
  const [a, b, tx, c, d, ty] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-9) return [...IDENTITY];
  const id = 1 / det;
  const ia = d * id;
  const ib = -b * id;
  const ic = -c * id;
  const idd = a * id;
  return [ia, ib, -(ia * tx + ib * ty), ic, idd, -(ic * tx + idd * ty)];
}

/** Shift needed (1D) to bring [lo,hi] inside [0,size]; centers it if too big. */
function shift1D(lo: number, hi: number, size: number): number {
  if (hi - lo >= size) return size / 2 - (lo + hi) / 2;
  if (lo < 0) return -lo;
  if (hi > size) return size - hi;
  return 0;
}

/**
 * Constrain a stabilization transform so the given crop rect stays fully filled
 * by source content (no black border). If the crop is inside the "safe area"
 * this returns the transform unchanged (full stabilization). If the crop is
 * larger, the transform is nudged on the frames where the movement would reveal
 * an edge — the stabilization "hits the border" instead of going off-frame.
 * Works for any affine (translation / rotation / scale).
 */
export function constrainToCrop(S: Affine, crop: Rect, w: number, h: number): Affine {
  const Minv = invertAffine(S);
  const corners: Point[] = [
    { x: crop.x, y: crop.y },
    { x: crop.x + crop.w, y: crop.y },
    { x: crop.x + crop.w, y: crop.y + crop.h },
    { x: crop.x, y: crop.y + crop.h },
  ];
  let sxmin = Infinity;
  let sxmax = -Infinity;
  let symin = Infinity;
  let symax = -Infinity;
  for (const c of corners) {
    const s = applyAffine(Minv, c);
    sxmin = Math.min(sxmin, s.x);
    sxmax = Math.max(sxmax, s.x);
    symin = Math.min(symin, s.y);
    symax = Math.max(symax, s.y);
  }
  const dx = shift1D(sxmin, sxmax, w);
  const dy = shift1D(symin, symax, h);
  if (dx === 0 && dy === 0) return S;
  // shift the inverse sampling so the crop maps back inside the source, then
  // re-invert to get the corrected forward transform.
  const Minv2: Affine = [Minv[0], Minv[1], Minv[2] + dx, Minv[3], Minv[4], Minv[5] + dy];
  return invertAffine(Minv2);
}

/** Scale about a center point (cx, cy). */
export function scaleAbout(s: number, cx: number, cy: number): Affine {
  return [s, 0, cx - s * cx, 0, s, cy - s * cy];
}

/**
 * Compute the affine that, applied to the CURRENT frame, brings the tracked
 * point(s) back to their REFERENCE position(s).
 *
 *  - one point  -> pure translation (camera shake removed, no rotation/scale)
 *  - two points -> similarity transform (translation + rotation + scale) so
 *                  BOTH points become and stay fixed.
 */
export function solveStabilize(
  mode: TrackMode,
  ref: Point[],
  cur: Point[]
): Affine {
  if (mode === 'one' || ref.length < 2 || cur.length < 2) {
    return [1, 0, ref[0].x - cur[0].x, 0, 1, ref[0].y - cur[0].y];
  }

  // Similarity transform mapping (cur0,cur1) -> (ref0,ref1).
  const va = { x: cur[1].x - cur[0].x, y: cur[1].y - cur[0].y };
  const vb = { x: ref[1].x - ref[0].x, y: ref[1].y - ref[0].y };
  const na2 = va.x * va.x + va.y * va.y;
  if (na2 < 1e-6) {
    return [1, 0, ref[0].x - cur[0].x, 0, 1, ref[0].y - cur[0].y];
  }
  // M = (1/|va|^2) * [ va·vb   (va×vb) ; -(va×vb)  va·vb ] gives s*cos / s*sin.
  const dot = va.x * vb.x + va.y * vb.y;
  const cross = va.x * vb.y - va.y * vb.x;
  const sc = dot / na2; // s*cos(theta)
  const ss = cross / na2; // s*sin(theta)
  const a = sc;
  const b = -ss;
  const c = ss;
  const d = sc;
  const tx = ref[0].x - (a * cur[0].x + b * cur[0].y);
  const ty = ref[0].y - (c * cur[0].x + d * cur[0].y);
  return [a, b, tx, c, d, ty];
}

/**
 * Temporal smoothing of a point trajectory: a Gaussian-weighted centered
 * average over a window of `radius` frames. Gaussian (vs box) rolls off high
 * frequencies far more cleanly, so the stabilized motion stays smooth.
 * Missing samples (failed tracking) are filled by carrying the last value.
 */
export function smoothTrajectory(points: (Point | null)[], radius = 1): Point[] {
  const n = points.length;
  // forward-fill nulls so gaps don't bias the average
  const filled: Point[] = new Array(n);
  let last: Point = points.find((p) => p) ?? { x: 0, y: 0 };
  for (let i = 0; i < n; i++) {
    if (points[i]) last = points[i] as Point;
    filled[i] = last;
  }
  if (radius <= 0) return filled;

  // Gaussian kernel
  const sigma = Math.max(0.6, radius / 2);
  const w: number[] = [];
  for (let k = -radius; k <= radius; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));

  const out: Point[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = Math.min(n - 1, Math.max(0, i + k)); // clamp edges
      const wk = w[k + radius];
      sx += filled[j].x * wk;
      sy += filled[j].y * wk;
      sw += wk;
    }
    out[i] = { x: sx / sw, y: sy / sw };
  }
  return out;
}

export { IDENTITY };
