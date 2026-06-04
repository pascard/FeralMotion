import { solveStabilize, smoothTrajectory } from './stabilizer';
import { PointTracker } from './tracker';
import { FrameGrabber, seekTo } from './videoFrames';
import { getPreset, StabPreset, DEFAULT_PRECISION } from './presets';
import { Affine, FrameTrack, IDENTITY, Point, TrackMode, VideoMeta } from './types';

/** A trivial result with no stabilization (identity transform), used for the
 * Color-only path: grading/exporting a clip that wasn't stabilized. */
export function identityResult(meta: VideoMeta): AnalysisResult {
  return {
    mode: 'one',
    ref: [],
    start: 0,
    end: meta.duration,
    fps: meta.fps,
    raw: [],
    times: [0],
    oks: [true],
    smoothing: 0,
    tracks: [{ time: 0, points: [], ok: true, stabilize: [...IDENTITY] as Affine }],
  };
}

export interface AnalysisResult {
  mode: TrackMode;
  ref: Point[];
  start: number;
  end: number;
  fps: number;
  tracks: FrameTrack[];
  /** raw tracked positions (per point index, per frame) kept so the
   * stabilization can be re-derived instantly when smoothing changes,
   * without re-running optical flow */
  raw: (Point | null)[][];
  times: number[];
  oks: boolean[];
  /** current smoothing radius used to build `tracks` */
  smoothing: number;
}

export interface AnalyzeParams {
  cv: any;
  video: HTMLVideoElement;
  meta: VideoMeta;
  mode: TrackMode;
  /** reference points in SOURCE pixels — where the user wants them locked */
  refPoints: Point[];
  start: number;
  end: number;
  smoothing?: number;
  /** stabilization power preset id (controls cloud size + optical-flow params) */
  precision?: string;
  /** per-zone sampling radius in SOURCE px (the circle the cloud is drawn from) */
  radii?: number[];
  /** called after each frame so the UI can render the live tracking pass */
  onFrame?: (info: {
    index: number;
    total: number;
    time: number;
    points: Point[]; // zone anchors
    cloud: Point[]; // individual tracked feature points
    ok: boolean;
  }) => void;
  signal?: AbortSignal;
}

/** Run the optical-flow tracking pass over the trimmed range. */
export async function analyzeStabilization(
  params: AnalyzeParams
): Promise<AnalysisResult> {
  const { cv, video, meta, mode, refPoints, start, end, onFrame, signal } = params;
  const preset = getPreset(params.precision ?? DEFAULT_PRECISION);
  const fps = meta.fps;
  const dt = 1 / fps;
  const total = Math.max(1, Math.round((end - start) * fps) + 1);
  // per-zone sampling radius (user circle), default scaled with resolution
  const defRadius = Math.round(preset.radius * (Math.min(meta.width, meta.height) / 720));
  const radii = refPoints.map((_, i) => Math.round(params.radii?.[i] ?? defRadius));
  console.log(
    `[analysis] start: ${total} frames @ ${fps}fps, preset=${preset.id} (${preset.perZone}pts/zone, radii=${radii})`
  );

  const grabber = new FrameGrabber(meta.width, meta.height);
  const tracker = new PointTracker(cv, preset.winSize, preset.maxLevel);

  // each zone (anchor) gets a CLOUD of feature points; we average their motion.
  const rawPoints: (Point | null)[][] = refPoints.map(() => []);
  const oks: boolean[] = [];
  const times: number[] = [];

  try {
    await seekTo(video, start);
    let frame = grabber.grab(video);

    // Build the per-zone point clouds around each anchor.
    const { points: cloudRef, group } = buildClusters(cv, frame, refPoints, radii, preset.perZone);
    console.log('[analysis] clouds built:', cloudRef.length, 'points for', refPoints.length, 'zone(s)');
    tracker.init(frame, cloudRef);

    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const t = Math.min(end, start + i * dt);
      times.push(t);

      let cur: Point[];
      let valid: boolean[];
      if (i === 0) {
        cur = cloudRef.map((p) => ({ ...p }));
        valid = cloudRef.map(() => true);
      } else {
        await seekTo(video, t);
        frame = grabber.grab(video);
        const res = tracker.track(frame);
        cur = res.points;
        valid = res.valid;
      }

      // Aggregate each zone's cloud → robust anchor position (median displacement).
      const anchors: Point[] = [];
      let allOk = true;
      for (let z = 0; z < refPoints.length; z++) {
        const dxs: number[] = [];
        const dys: number[] = [];
        for (let k = 0; k < cur.length; k++) {
          if (group[k] !== z || !valid[k]) continue;
          dxs.push(cur[k].x - cloudRef[k].x);
          dys.push(cur[k].y - cloudRef[k].y);
        }
        const minNeeded = Math.max(2, Math.ceil(0.25 * countGroup(group, z)));
        if (dxs.length < minNeeded) {
          allOk = false;
          rawPoints[z].push(null);
          anchors.push(refPoints[z]);
        } else {
          const a = { x: refPoints[z].x + median(dxs), y: refPoints[z].y + median(dys) };
          rawPoints[z].push(a);
          anchors.push(a);
        }
      }
      oks.push(allOk);
      const cloud = cur.filter((_, k) => valid[k]);
      onFrame?.({ index: i, total, time: t, points: anchors, cloud, ok: allOk });
      await raf();
    }
    console.log('[analysis] tracking loop done');
  } finally {
    tracker.dispose();
  }

  const smoothing = params.smoothing ?? 1;
  const result: AnalysisResult = {
    mode,
    ref: refPoints,
    start,
    end,
    fps,
    raw: rawPoints,
    times,
    oks,
    smoothing,
    tracks: [],
  };
  result.tracks = buildTracks(result, smoothing);
  console.log('[analysis] result built:', result.tracks.length, 'frames');
  return result;
}

/** Derive per-frame stabilization transforms from the raw tracked points for a
 * given smoothing radius. Cheap — runs in a few ms, no optical flow. */
export function buildTracks(result: AnalysisResult, smoothing: number): FrameTrack[] {
  const radius = Math.max(0, Math.round(smoothing));
  const smoothed = result.raw.map((traj) => smoothTrajectory(traj, radius));
  return result.times.map((time, i) => {
    const cur = smoothed.map((s) => s[i]);
    const stabilize: Affine = solveStabilize(result.mode, result.ref, cur);
    return { time, points: cur, ok: result.oks[i], stabilize };
  });
}

/** Return a copy of the result with stabilization re-derived at a new smoothing
 * radius. Used by the sensitivity slider for instant preview updates. */
export function recomputeTracks(result: AnalysisResult, smoothing: number): AnalysisResult {
  return { ...result, smoothing, tracks: buildTracks(result, smoothing) };
}

/** Nearest-frame lookup of the stabilization transform for a given time. */
export function trackAt(result: AnalysisResult, time: number): FrameTrack {
  const idx = Math.round((time - result.start) * result.fps);
  const clamped = Math.min(result.tracks.length - 1, Math.max(0, idx));
  return result.tracks[clamped];
}

function raf(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function countGroup(group: number[], z: number): number {
  let n = 0;
  for (const g of group) if (g === z) n++;
  return n;
}

/**
 * Build a cloud of trackable feature points around each anchor (zone). Uses
 * OpenCV goodFeaturesToTrack inside a circular mask per zone; always includes
 * the anchor itself, and falls back to a ring of points if the zone is too
 * featureless. Returns the points plus a `group[i]` mapping point→zone index.
 */
function buildClusters(
  cv: any,
  frame: ImageData,
  anchors: Point[],
  radii: number[],
  perZone: number
): { points: Point[]; group: number[] } {
  const w = frame.width;
  const h = frame.height;
  const points: Point[] = [];
  const group: number[] = [];

  const src = cv.matFromImageData(frame);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  src.delete();

  anchors.forEach((a, ai) => {
    const radius = Math.max(8, radii[ai] ?? 40);
    // always include the anchor itself
    points.push({ x: a.x, y: a.y });
    group.push(ai);

    let found: Point[] = [];
    try {
      const mask = cv.Mat.zeros(h, w, cv.CV_8UC1);
      cv.circle(mask, new cv.Point(Math.round(a.x), Math.round(a.y)), radius, new cv.Scalar(255), -1);
      const corners = new cv.Mat();
      cv.goodFeaturesToTrack(
        gray,
        corners,
        perZone + 4,
        0.01,
        Math.max(4, radius / 6),
        mask,
        7
      );
      for (let i = 0; i < corners.rows; i++) {
        found.push({ x: corners.data32F[i * 2], y: corners.data32F[i * 2 + 1] });
      }
      corners.delete();
      mask.delete();
    } catch (e) {
      console.warn('[analysis] goodFeaturesToTrack failed, using ring fallback', e);
    }

    found = found
      .filter((p) => Math.hypot(p.x - a.x, p.y - a.y) > 2) // skip the anchor dup
      .slice(0, perZone - 1);

    // ring fallback if the zone is too featureless
    if (found.length < Math.min(5, perZone - 1)) {
      const rings = [0.5, 0.85];
      rings.forEach((rf) => {
        const r = radius * rf;
        for (let k = 0; k < 6; k++) {
          const ang = (k / 6) * Math.PI * 2;
          const x = a.x + Math.cos(ang) * r;
          const y = a.y + Math.sin(ang) * r;
          if (x > 2 && x < w - 2 && y > 2 && y < h - 2) found.push({ x, y });
        }
      });
      found = found.slice(0, perZone - 1);
    }

    found.forEach((p) => {
      points.push(p);
      group.push(ai);
    });
  });

  gray.delete();
  return { points, group };
}
