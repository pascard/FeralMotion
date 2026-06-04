import { GradeRenderer } from './GradeRenderer';
import { compose } from '../engine/stabilizer';
import { Affine, Rect, VideoMeta } from '../engine/types';
import { GradeParams } from './types';

/**
 * The full FeralMotion frame pipeline, shared by the Color preview and the
 * exporter: video → (stabilize + crop, one resample on a 2D canvas) → color
 * grade (WebGL shader) → output canvas. Output is sized to the crop, even
 * dimensions for H.264.
 */
export function makeComposite(meta: VideoMeta, crop: Rect) {
  const outW = Math.max(2, Math.round(crop.w) - (Math.round(crop.w) % 2));
  const outH = Math.max(2, Math.round(crop.h) - (Math.round(crop.h) % 2));

  // stage: stabilized + cropped frame (2D)
  const stage = document.createElement('canvas');
  stage.width = outW;
  stage.height = outH;
  const sctx = stage.getContext('2d', { alpha: false })!;

  // graded output (WebGL)
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const grader = new GradeRenderer(out);

  const sx = outW / crop.w;
  const sy = outH / crop.h;
  const cropMap: Affine = [sx, 0, -crop.x * sx, 0, sy, -crop.y * sy];

  const draw = (video: CanvasImageSource, stabilize: Affine, grade: GradeParams, time = 0) => {
    const m = compose(stabilize, cropMap);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.fillStyle = '#000';
    sctx.fillRect(0, 0, outW, outH);
    sctx.setTransform(m[0], m[3], m[1], m[4], m[2], m[5]);
    sctx.imageSmoothingQuality = 'high';
    try {
      sctx.drawImage(video, 0, 0, meta.width, meta.height);
    } catch {
      /* frame not ready */
    }
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    grader.render(stage, outW, outH, grade, time);
  };

  const dispose = () => grader.dispose();

  return { outW, outH, canvas: out, draw, dispose };
}

export type Composite = ReturnType<typeof makeComposite>;
