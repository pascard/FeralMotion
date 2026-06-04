export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TrackMode = 'one' | 'two';

/** A 2x3 affine transform stored row-major: [a, b, tx, c, d, ty]
 * Maps source pixel (x,y) -> (a*x + b*y + tx, c*x + d*y + ty). */
export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 0, 1, 0];

/** Per-frame tracking + stabilization result. */
export interface FrameTrack {
  /** media time of the frame, in seconds */
  time: number;
  /** raw tracked point positions in source pixels (1 or 2 entries) */
  points: Point[];
  /** whether tracking was confident for this frame */
  ok: boolean;
  /** affine applied to the source frame to stabilize it (2x3) */
  stabilize: Affine;
}

export interface VideoMeta {
  width: number;
  height: number;
  duration: number;
  /** estimated frames per second */
  fps: number;
}
