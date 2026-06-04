import { compose, scaleAbout } from './stabilizer';
import { Affine, Point, Rect } from './types';

type FrameSource = CanvasImageSource;

/**
 * Draw a source frame onto ctx applying the stabilization affine plus an
 * optional crop-zoom (applied about the output center to hide the moving
 * borders). The output canvas keeps the source resolution.
 */
export function drawStabilized(
  ctx: CanvasRenderingContext2D,
  source: FrameSource,
  stabilize: Affine,
  width: number,
  height: number,
  cropZoom = 1
) {
  const zoom: Affine = scaleAbout(cropZoom, width / 2, height / 2);
  const m: Affine = compose(stabilize, zoom); // apply stabilize, then zoom

  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  // Affine [A,B,Tx,C,D,Ty] -> canvas setTransform(A, C, B, D, Tx, Ty)
  ctx.setTransform(m[0], m[3], m[1], m[4], m[2], m[5]);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  ctx.restore();
}

/** Draw the raw (unstabilized) frame. */
export function drawRaw(
  ctx: CanvasRenderingContext2D,
  source: FrameSource,
  width: number,
  height: number
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
}

/** Draw a map-style pin anchored (tip) at display point d. */
export function drawPin(
  ctx: CanvasRenderingContext2D,
  d: Point,
  scale = 1,
  color = '#19f0c8',
  label?: string
) {
  const r = 9 * scale;
  const head = { x: d.x, y: d.y - 22 * scale };
  ctx.save();
  // stem
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 4 * scale;
  ctx.beginPath();
  ctx.moveTo(d.x, d.y);
  ctx.lineTo(head.x, head.y);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5 * scale;
  ctx.beginPath();
  ctx.moveTo(d.x, d.y);
  ctx.lineTo(head.x, head.y);
  ctx.stroke();
  // head
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(head.x, head.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#05130f';
  ctx.beginPath();
  ctx.arc(head.x, head.y, r * 0.45, 0, Math.PI * 2);
  ctx.fill();
  // tip dot
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(d.x, d.y, 2.5 * scale, 0, Math.PI * 2);
  ctx.fill();
  if (label) {
    ctx.fillStyle = '#05130f';
    ctx.font = `${Math.round(11 * scale)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, head.x, head.y);
  }
  ctx.restore();
}

export function drawPins(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  toDisplay: (p: Point) => Point,
  scale = 1
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  points.forEach((p, i) =>
    drawPin(ctx, toDisplay(p), scale, '#19f0c8', points.length > 1 ? String(i + 1) : undefined)
  );
}

/** Draw the export frame: dim everything outside the crop rect, outline it, and
 * draw corner + edge resize handles. Optionally draw the safe-area boundary. */
export function drawExportFrame(
  ctx: CanvasRenderingContext2D,
  crop: Rect,
  toDisplay: (p: Point) => Point,
  canvasW: number,
  canvasH: number,
  scale = 1,
  safe?: Rect | null
) {
  const tl = toDisplay({ x: crop.x, y: crop.y });
  const br = toDisplay({ x: crop.x + crop.w, y: crop.y + crop.h });
  const x = tl.x;
  const y = tl.y;
  const w = br.x - tl.x;
  const h = br.y - tl.y;

  // green when the crop fits inside the safe area, orange when it exceeds it
  // (the stabilization will then "hit the borders" on big moves).
  const eps = 1.5;
  const exceeds = !!safe && (
    crop.x < safe.x - eps ||
    crop.y < safe.y - eps ||
    crop.x + crop.w > safe.x + safe.w + eps ||
    crop.y + crop.h > safe.y + safe.h + eps
  );
  const color = exceeds ? '#ff9f43' : '#19f0c8';

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.save();

  // dim outside the crop
  ctx.fillStyle = 'rgba(8,8,12,0.62)';
  ctx.beginPath();
  ctx.rect(0, 0, canvasW, canvasH);
  ctx.rect(x, y, w, h);
  ctx.fill('evenodd');

  // safe-area boundary (max available with full stabilization)
  if (safe) {
    const s1 = toDisplay({ x: safe.x, y: safe.y });
    const s2 = toDisplay({ x: safe.x + safe.w, y: safe.y + safe.h });
    ctx.strokeStyle = exceeds ? 'rgba(255,159,67,0.6)' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1 * scale;
    ctx.setLineDash([4 * scale, 4 * scale]);
    ctx.strokeRect(s1.x, s1.y, s2.x - s1.x, s2.y - s1.y);
    ctx.setLineDash([]);
  }

  // crop border
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * scale;
  ctx.strokeRect(x, y, w, h);

  // rule-of-thirds guides
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1 * scale;
  ctx.beginPath();
  for (let i = 1; i <= 2; i++) {
    ctx.moveTo(x + (w * i) / 3, y);
    ctx.lineTo(x + (w * i) / 3, y + h);
    ctx.moveTo(x, y + (h * i) / 3);
    ctx.lineTo(x + w, y + (h * i) / 3);
  }
  ctx.stroke();

  // corner handles
  const hs = 12 * scale;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3 * scale;
  const corners = [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x + w, y + h, -1, -1],
    [x, y + h, 1, -1],
  ];
  corners.forEach(([cx, cy, sx, sy]) => {
    ctx.beginPath();
    ctx.moveTo(cx + sx * hs, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + sy * hs);
    ctx.stroke();
  });
  ctx.restore();
}

export interface OverlayOptions {
  /** map a source-pixel point to canvas/display pixels */
  toDisplay: (p: Point) => Point;
  /** trailing recent positions for the "tracking" motion feel */
  trails?: Point[][];
  /** individual tracked feature points (the per-zone cloud) */
  cloud?: Point[];
  color?: string;
  /** tracker confidence; turns markers amber/red when low */
  ok?: boolean;
  /** marker scale (for high-DPI / zoom) */
  scale?: number;
}

/**
 * Draw the animated tracking markers: a reticle + search box around each
 * tracked point, plus a fading motion trail — the visible "tracking" effect.
 */
export function drawTrackingOverlay(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  opts: OverlayOptions
) {
  const { toDisplay, trails, ok = true, scale = 1, cloud } = opts;
  const color = opts.color ?? (ok ? '#19f0c8' : '#ffb020');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.save();
  ctx.lineWidth = 2 * scale;

  // Tracked feature cloud (the points being averaged per zone).
  if (cloud && cloud.length) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.6;
    for (const p of cloud) {
      const d = toDisplay(p);
      ctx.beginPath();
      ctx.arc(d.x, d.y, 1.6 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Motion trails.
  if (trails) {
    trails.forEach((trail) => {
      for (let i = 1; i < trail.length; i++) {
        const a = toDisplay(trail[i - 1]);
        const b = toDisplay(trail[i]);
        ctx.globalAlpha = (i / trail.length) * 0.7;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;
  }

  // Connecting line between two points.
  if (points.length === 2) {
    const a = toDisplay(points[0]);
    const b = toDisplay(points[1]);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([6 * scale, 5 * scale]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  points.forEach((p) => {
    const d = toDisplay(p);
    const box = 26 * scale;
    const gap = 6 * scale;
    ctx.strokeStyle = color;
    // animated-looking corner brackets (search window)
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    corners.forEach(([sx, sy]) => {
      const cx = d.x + sx * box;
      const cy = d.y + sy * box;
      ctx.beginPath();
      ctx.moveTo(cx, cy - sy * (box / 2));
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx - sx * (box / 2), cy);
      ctx.stroke();
    });
    // center reticle
    ctx.beginPath();
    ctx.moveTo(d.x - gap * 2, d.y);
    ctx.lineTo(d.x - gap, d.y);
    ctx.moveTo(d.x + gap, d.y);
    ctx.lineTo(d.x + gap * 2, d.y);
    ctx.moveTo(d.x, d.y - gap * 2);
    ctx.lineTo(d.x, d.y - gap);
    ctx.moveTo(d.x, d.y + gap);
    ctx.lineTo(d.x, d.y + gap * 2);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(d.x, d.y, 2.5 * scale, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.restore();
}
