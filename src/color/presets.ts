import { GradeParams, NEUTRAL, ToneMap } from './types';

export interface Look {
  id: string;
  label: string;
  params: GradeParams;
}

const make = (p: Partial<GradeParams>): GradeParams => ({ ...NEUTRAL, ...p });

export const LOOKS: Look[] = [
  { id: 'neutral', label: 'Neutre', params: make({}) },
  {
    id: 'cine-warm',
    label: 'Ciné chaud',
    params: make({
      temp: 0.18,
      contrast: 0.18,
      highlights: -0.1,
      toneMap: ToneMap.ACES,
      saturation: -0.05,
      vibrance: 0.15,
      tealOrange: 0.25,
      vignette: 0.18,
      letterbox: 2.39,
    }),
  },
  {
    id: 'teal-orange',
    label: 'Teal & Orange',
    params: make({
      temp: 0.05,
      contrast: 0.22,
      toneMap: ToneMap.ACES,
      saturation: 0.05,
      tealOrange: 0.55,
      shadows: -0.05,
      vignette: 0.15,
    }),
  },
  {
    id: 'film',
    label: 'Argentique',
    params: make({
      temp: 0.08,
      contrast: 0.1,
      toneMap: ToneMap.Hable,
      saturation: -0.12,
      vibrance: 0.1,
      fade: 0.18,
      grain: 0.45,
      tealOrange: 0.15,
      letterbox: 1.85,
    }),
  },
  {
    id: 'faded',
    label: 'Faded',
    params: make({
      temp: -0.05,
      contrast: -0.05,
      toneMap: ToneMap.Reinhard,
      saturation: -0.2,
      fade: 0.35,
      highlights: -0.15,
      grain: 0.2,
    }),
  },
  {
    id: 'noir',
    label: 'Noir',
    params: make({
      contrast: 0.3,
      toneMap: ToneMap.ACES,
      saturation: -1,
      vignette: 0.3,
      grain: 0.3,
      letterbox: 2.39,
    }),
  },
];
