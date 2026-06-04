import { Point } from './types';

/**
 * Sparse point tracker built on OpenCV.js pyramidal Lucas-Kanade optical flow.
 * Feed it frames sequentially; it returns the new position of each tracked
 * point. Includes a forward-backward consistency check to reject bad tracks.
 */
export class PointTracker {
  private cv: any;
  private prevGray: any | null = null;
  private prevPts: any | null = null;
  private n = 0;
  private winSize: any;
  private maxLevel = 3;
  private criteria: any;

  constructor(cv: any, winSize = 25, maxLevel = 3) {
    this.cv = cv;
    this.winSize = new cv.Size(winSize, winSize);
    this.maxLevel = maxLevel;
    this.criteria = new cv.TermCriteria(
      cv.TermCriteria_EPS | cv.TermCriteria_COUNT,
      30,
      0.01
    );
  }

  init(frame: ImageData, points: Point[]) {
    this.n = points.length;
    this.prevGray = this.toGray(frame);
    this.prevPts = this.toMat(points);
  }

  /** Track points into the next frame. Returns positions + per-point validity. */
  track(frame: ImageData): { points: Point[]; valid: boolean[] } {
    const cv = this.cv;
    const gray = this.toGray(frame);

    const nextPts = new cv.Mat();
    const status = new cv.Mat();
    const err = new cv.Mat();
    cv.calcOpticalFlowPyrLK(
      this.prevGray,
      gray,
      this.prevPts,
      nextPts,
      status,
      err,
      this.winSize,
      this.maxLevel,
      this.criteria
    );

    // Forward-backward check: track back and compare to the start point.
    const back = new cv.Mat();
    const backStatus = new cv.Mat();
    const backErr = new cv.Mat();
    cv.calcOpticalFlowPyrLK(
      gray,
      this.prevGray,
      nextPts,
      back,
      backStatus,
      backErr,
      this.winSize,
      this.maxLevel,
      this.criteria
    );

    const points: Point[] = [];
    const valid: boolean[] = [];
    for (let i = 0; i < this.n; i++) {
      const nx = nextPts.data32F[i * 2];
      const ny = nextPts.data32F[i * 2 + 1];
      const bx = back.data32F[i * 2];
      const by = back.data32F[i * 2 + 1];
      const ox = this.prevPts.data32F[i * 2];
      const oy = this.prevPts.data32F[i * 2 + 1];
      const fbErr = Math.hypot(bx - ox, by - oy);
      valid.push(!!status.data[i] && fbErr <= 2.0);
      points.push({ x: nx, y: ny });
    }

    // Advance state.
    this.prevGray.delete();
    this.prevGray = gray;
    this.prevPts.delete();
    this.prevPts = nextPts;
    status.delete();
    err.delete();
    back.delete();
    backStatus.delete();
    backErr.delete();

    return { points, valid };
  }

  /** Reset the reference points (e.g. after a manual correction). */
  reseed(points: Point[]) {
    this.prevPts?.delete();
    this.prevPts = this.toMat(points);
    this.n = points.length;
  }

  private toMat(points: Point[]): any {
    const cv = this.cv;
    const m = new cv.Mat(points.length, 1, cv.CV_32FC2);
    for (let i = 0; i < points.length; i++) {
      m.data32F[i * 2] = points[i].x;
      m.data32F[i * 2 + 1] = points[i].y;
    }
    return m;
  }

  private toGray(frame: ImageData): any {
    const cv = this.cv;
    const src = cv.matFromImageData(frame);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    src.delete();
    return gray;
  }

  dispose() {
    this.prevGray?.delete();
    this.prevPts?.delete();
    this.prevGray = null;
    this.prevPts = null;
  }
}
