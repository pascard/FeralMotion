import { GradeParams } from './types';

/**
 * Approximate the grade as a CSS `filter` string for the lightweight previews
 * (stabilization steps) that display the NATIVE <video> element — so the look
 * is visible everywhere without GL (mobile-safe, no texImage2D black frames).
 * The pixel-faithful pipeline (tone map, teal&orange, grain…) runs in the Color
 * editor and at export; this is a close visual approximation of the tonal and
 * white-balance shift. CSS filters don't affect drawImage/texImage2D pixels, so
 * this never pollutes the GL composite used for export.
 */
export function gradeToCssFilter(g: GradeParams): string {
  const f: string[] = [];

  if (g.exposure) f.push(`brightness(${clamp(Math.pow(2, g.exposure), 0.2, 4).toFixed(3)})`);
  if (g.contrast) f.push(`contrast(${clamp(1 + g.contrast * 0.85, 0.2, 2.5).toFixed(3)})`);

  const sat = 1 + g.saturation + g.vibrance * 0.5;
  if (Math.abs(sat - 1) > 0.001) f.push(`saturate(${clamp(sat, 0, 3).toFixed(3)})`);

  // white balance approximation
  if (g.temp > 0) f.push(`sepia(${clamp(g.temp * 0.4, 0, 1).toFixed(3)})`);
  else if (g.temp < 0) f.push(`hue-rotate(${(g.temp * 22).toFixed(1)}deg) saturate(1.04)`);
  if (g.tint) f.push(`hue-rotate(${(-g.tint * 18).toFixed(1)}deg)`);

  // faded film: lift + lower contrast
  if (g.fade) {
    f.push(`contrast(${clamp(1 - g.fade * 0.3, 0.4, 1).toFixed(3)})`);
    f.push(`brightness(${(1 + g.fade * 0.06).toFixed(3)})`);
  }

  return f.length ? f.join(' ') : 'none';
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
