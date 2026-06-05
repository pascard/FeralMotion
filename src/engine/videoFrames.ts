import { VideoMeta } from './types';

/** Resolve once the video's metadata (dimensions/duration) is known. We use
 * `loadedmetadata` rather than `loadeddata` because mobile browsers often do
 * NOT decode the first frame (loadeddata) until a play() — which would make the
 * loader hang forever. A timeout guards against a totally unreadable source. */
export function waitForVideoReady(video: HTMLVideoElement, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.videoWidth && Number.isFinite(video.duration)) return resolve();
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('loadeddata', onMeta);
      video.removeEventListener('error', onErr);
      err ? reject(err) : resolve();
    };
    const onMeta = () => {
      if (video.videoWidth) finish();
    };
    const onErr = () => finish(new Error('Could not load this video.'));
    const timer = setTimeout(() => {
      if (video.videoWidth) finish();
      else finish(new Error('Video loading timed out.'));
    }, timeoutMs);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('loadeddata', onMeta);
    video.addEventListener('error', onErr);
    // nudge mobile browsers that wait before fetching
    try {
      video.load();
    } catch {
      /* ignore */
    }
  });
}

/** Snap a measured fps to the nearest standard rate so the export grid lines up
 * exactly with the source frames (no judder/drift). Keeps the FRACTIONAL value
 * for NTSC rates (29.97, 23.976, 59.94) — rounding those to integers is what
 * causes duplicated/skipped frames and slow A/V drift. */
function snapFps(fps: number): number {
  const standard = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
  for (const s of standard) if (Math.abs(fps - s) <= 0.25) return s;
  return Math.min(60, Math.max(12, Math.round(fps * 1000) / 1000));
}

/** Estimate fps by sampling frame callbacks; falls back to 30. */
export async function detectFps(video: HTMLVideoElement): Promise<number> {
  const anyVid = video as any;
  if (typeof anyVid.requestVideoFrameCallback !== 'function') return 30;

  return new Promise<number>((resolve) => {
    const times: number[] = [];
    let settled = false;
    const finish = (fps: number) => {
      if (settled) return;
      settled = true;
      try {
        video.pause();
        video.currentTime = 0;
      } catch {
        /* ignore */
      }
      resolve(snapFps(fps));
    };
    const cb = (_now: number, meta: any) => {
      times.push(meta.mediaTime);
      if (times.length >= 12) {
        const deltas: number[] = [];
        for (let i = 1; i < times.length; i++) {
          const d = times[i] - times[i - 1];
          if (d > 0) deltas.push(d);
        }
        if (!deltas.length) return finish(30);
        deltas.sort((a, b) => a - b);
        const med = deltas[Math.floor(deltas.length / 2)];
        finish(med > 0 ? 1 / med : 30);
      } else {
        anyVid.requestVideoFrameCallback(cb);
      }
    };
    video.muted = true;
    Promise.resolve(video.play())
      .then(() => anyVid.requestVideoFrameCallback(cb))
      .catch(() => finish(30));
    // hard safety: never let fps detection hold up the loader
    setTimeout(() => finish(30), 2500);
  });
}

export async function probeVideo(video: HTMLVideoElement): Promise<VideoMeta> {
  await waitForVideoReady(video);
  const fps = await detectFps(video);
  return {
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration,
    fps,
  };
}

/** Seek the video to a precise time and resolve once the frame is presented.
 * Includes a watchdog so a missing `seeked` event can never hang the pipeline. */
export function seekTo(video: HTMLVideoElement, time: number, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    const dur = Number.isFinite(video.duration) ? video.duration : time + 1;
    const target = Math.min(Math.max(0, time), Math.max(0, dur - 1e-3));
    if (Math.abs(video.currentTime - target) < 1e-3) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', onSeeked);
      clearTimeout(timer);
      resolve();
    };
    const onSeeked = () => finish();
    const timer = setTimeout(() => {
      console.warn(`[seekTo] no 'seeked' within ${timeoutMs}ms at t=${target.toFixed(3)}`);
      finish();
    }, timeoutMs);
    video.addEventListener('seeked', onSeeked);
    try {
      video.currentTime = target;
    } catch {
      finish();
    }
  });
}

/** A reusable offscreen surface to pull ImageData out of a video frame. */
export class FrameGrabber {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  constructor(public width: number, public height: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }
  grab(video: HTMLVideoElement): ImageData {
    this.ctx.drawImage(video, 0, 0, this.width, this.height);
    return this.ctx.getImageData(0, 0, this.width, this.height);
  }
}
