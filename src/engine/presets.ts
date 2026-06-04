/** Stabilization "power" presets. Each tracks a CLOUD of feature points per
 * zone and averages them (robust median) for a precise, stable anchor. More
 * points + bigger windows = more precise but slower. */
export interface StabPreset {
  id: string;
  label: string;
  hint: string;
  /** target feature points per zone (the cloud) */
  perZone: number;
  /** half-size of the zone the cloud is sampled from, in px @720p (scaled up) */
  radius: number;
  /** Lucas-Kanade window size */
  winSize: number;
  /** optical-flow pyramid levels */
  maxLevel: number;
}

export const PRECISIONS: StabPreset[] = [
  { id: 'fast', label: 'Rapide', hint: 'léger, idéal mobile', perZone: 8, radius: 26, winSize: 21, maxLevel: 2 },
  { id: 'balanced', label: 'Équilibré', hint: 'recommandé', perZone: 20, radius: 40, winSize: 27, maxLevel: 3 },
  { id: 'precise', label: 'Précis', hint: 'plus lent, plus stable', perZone: 44, radius: 56, winSize: 31, maxLevel: 4 },
];

export const DEFAULT_PRECISION = 'balanced';

export function getPreset(id: string): StabPreset {
  return PRECISIONS.find((p) => p.id === id) ?? PRECISIONS[1];
}
