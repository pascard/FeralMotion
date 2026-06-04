export type { VideoMeta } from '../engine/types';

/** Tone-map operators (applied in linear light). */
export enum ToneMap {
  None = 0,
  Reinhard = 1, // doux
  ACES = 2, // filmique
  Hable = 3, // argentique
}

/** Full grading state. All ranges are designed so 0 = neutral. */
export interface GradeParams {
  temp: number;
  tint: number;
  exposure: number;
  contrast: number;
  shadows: number;
  highlights: number;
  toneMap: ToneMap;
  saturation: number;
  vibrance: number;
  tealOrange: number;
  fade: number;
  vignette: number;
  grain: number;
  letterbox: number;
}

export const NEUTRAL: GradeParams = {
  temp: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  shadows: 0,
  highlights: 0,
  toneMap: ToneMap.None,
  saturation: 0,
  vibrance: 0,
  tealOrange: 0,
  fade: 0,
  vignette: 0,
  grain: 0,
  letterbox: 0,
};

export function cloneParams(p: GradeParams): GradeParams {
  return { ...p };
}

export function isNeutral(p: GradeParams): boolean {
  return (
    p.temp === 0 &&
    p.tint === 0 &&
    p.exposure === 0 &&
    p.contrast === 0 &&
    p.shadows === 0 &&
    p.highlights === 0 &&
    p.toneMap === ToneMap.None &&
    p.saturation === 0 &&
    p.vibrance === 0 &&
    p.tealOrange === 0 &&
    p.fade === 0 &&
    p.vignette === 0 &&
    p.grain === 0 &&
    p.letterbox === 0
  );
}
