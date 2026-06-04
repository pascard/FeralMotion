import { applyAffine } from './stabilizer';
import { AnalysisResult } from './analysis';
import { Rect } from './types';

export interface AspectFormat {
  id: string;
  label: string;
  /** width / height, or 0 to mean "max available area" */
  ratio: number;
}

export const FORMATS: AspectFormat[] = [
  { id: 'max', label: 'Max', ratio: 0 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
];

/**
 * The maximum usable frame = the source frame MINUS the full extent of the
 * (smoothed) stabilization movement. For every frame we warp the 4 source
 * corners by the stabilization transform; the always-covered axis-aligned
 * rectangle is the intersection of those warped rectangles. For pure
 * translation this is exact ("video − peak-to-peak movement"); for rotation/
 * scale it stays conservative (uses the inner corners) so no black ever shows.
 */
export function computeSafeRect(
  result: AnalysisResult,
  w: number,
  h: number,
  start = result.start,
  end = result.end
): Rect {
  let L = -1e9;
  let R = 1e9;
  let T = -1e9;
  let B = 1e9;
  for (const tr of result.tracks) {
    if (tr.time < start - 1e-3 || tr.time > end + 1e-3) continue; // only frames in range
    const m = tr.stabilize;
    const tl = applyAffine(m, { x: 0, y: 0 });
    const tr_ = applyAffine(m, { x: w, y: 0 });
    const br = applyAffine(m, { x: w, y: h });
    const bl = applyAffine(m, { x: 0, y: h });
    L = Math.max(L, tl.x, bl.x);
    R = Math.min(R, tr_.x, br.x);
    T = Math.max(T, tl.y, tr_.y);
    B = Math.min(B, bl.y, br.y);
  }
  L = Math.max(0, L);
  T = Math.max(0, T);
  R = Math.min(w, R);
  B = Math.min(h, B);
  if (R - L < 16 || B - T < 16) return { x: 0, y: 0, w, h }; // degenerate guard
  return { x: L, y: T, w: R - L, h: B - T };
}

/** Largest rect of the given aspect (w/h; <=0 => the safe rect itself),
 * centered inside the safe rect. */
export function fitAspect(safe: Rect, ratio: number): Rect {
  if (ratio <= 0) return { ...safe };
  let ww = safe.w;
  let hh = ww / ratio;
  if (hh > safe.h) {
    hh = safe.h;
    ww = hh * ratio;
  }
  return { x: safe.x + (safe.w - ww) / 2, y: safe.y + (safe.h - hh) / 2, w: ww, h: hh };
}

/** Linear interpolation between two rects. */
export function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  };
}

/** Keep a rect inside the safe area (clamps size then position). */
export function clampInside(safe: Rect, r: Rect): Rect {
  const w = Math.min(r.w, safe.w);
  const h = Math.min(r.h, safe.h);
  const x = Math.min(Math.max(r.x, safe.x), safe.x + safe.w - w);
  const y = Math.min(Math.max(r.y, safe.y), safe.y + safe.h - h);
  return { x, y, w, h };
}

export function moveRect(safe: Rect, r: Rect, dx: number, dy: number): Rect {
  return clampInside(safe, { ...r, x: r.x + dx, y: r.y + dy });
}

/** Resize from a corner, aspect-locked, clamped to the safe area. */
export function resizeRect(
  safe: Rect,
  r: Rect,
  corner: number, // 0 TL, 1 TR, 2 BR, 3 BL
  tx: number,
  ty: number,
  minSize = 48
): Rect {
  const ar = r.w / r.h;
  const anchor = [
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
  ][corner];

  let nw = Math.abs(tx - anchor.x);
  let nh = nw / ar;
  if (Math.abs(ty - anchor.y) > nh) {
    nh = Math.abs(ty - anchor.y);
    nw = nh * ar;
  }
  nw = Math.max(minSize, nw);
  nh = Math.max(minSize / ar, nh);
  const x = corner === 0 || corner === 3 ? anchor.x - nw : anchor.x;
  const y = corner === 0 || corner === 1 ? anchor.y - nh : anchor.y;
  return clampInside(safe, { x, y, w: nw, h: nh });
}
