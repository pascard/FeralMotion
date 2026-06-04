import { GradeParams } from './types';

export interface Stats {
  r: number;
  g: number;
  b: number;
  luma: number; // all in sRGB 0..1
}

const sampler = document.createElement('canvas');
sampler.width = 80;
sampler.height = 45;
const sctx = sampler.getContext('2d', { willReadFrequently: true })!;

/** Average colour of the current frame, sampled at low resolution. */
export function analyzeFrame(source: CanvasImageSource): Stats {
  sctx.drawImage(source, 0, 0, sampler.width, sampler.height);
  const { data } = sctx.getImageData(0, 0, sampler.width, sampler.height);
  let r = 0;
  let g = 0;
  let b = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  r /= n * 255;
  g /= n * 255;
  b /= n * 255;
  return { r, g, b, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
}

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Auto-exposure: push mean luminance toward a pleasant target. */
export function autoExposure(stats: Stats, target = 0.45): number {
  const cur = Math.max(0.01, toLin(stats.luma));
  const tgt = toLin(target);
  return clamp(Math.log2(tgt / cur), -2, 2);
}

/** Auto white balance (grey-world): neutralise the average colour cast. */
export function autoWhiteBalance(stats: Stats): { temp: number; tint: number } {
  const avg = (stats.r + stats.g + stats.b) / 3 || 0.001;
  // warm if R>B → reduce temp; our temp raises R lowers B
  const temp = clamp(((stats.b - stats.r) / avg) * 0.6, -1, 1);
  const tint = clamp(((stats.g - (stats.r + stats.b) / 2) / avg) * -0.6, -1, 1);
  return { temp, tint };
}

/**
 * Match a clip to a reference clip by aligning mean luminance + colour cast.
 * Returns absolute values to set on the target's params (a pragmatic match —
 * not a full LUT, but enough to homogenise a set of clips).
 */
export function matchToReference(
  ref: Stats,
  tgt: Stats
): Pick<GradeParams, 'exposure' | 'temp' | 'tint'> {
  const exposure = clamp(Math.log2(Math.max(0.01, toLin(ref.luma)) / Math.max(0.01, toLin(tgt.luma))), -2.5, 2.5);
  // colour cast difference (ref vs target), mapped into temp/tint
  const tgtAvg = (tgt.r + tgt.g + tgt.b) / 3 || 0.001;
  const refWarm = ref.r - ref.b;
  const tgtWarm = tgt.r - tgt.b;
  const temp = clamp(((refWarm - tgtWarm) / tgtAvg) * 0.6, -1, 1);
  const refGreen = ref.g - (ref.r + ref.b) / 2;
  const tgtGreen = tgt.g - (tgt.r + tgt.b) / 2;
  const tint = clamp(((tgtGreen - refGreen) / tgtAvg) * 0.6, -1, 1);
  return { exposure, temp, tint };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
