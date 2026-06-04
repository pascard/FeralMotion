import { useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { drawTrackingOverlay, drawPins, drawExportFrame } from '../engine/renderer';
import { compose } from '../engine/stabilizer';
import { Affine, IDENTITY, Point, Rect, TrackMode, VideoMeta } from '../engine/types';
import { GradeRenderer } from '../color/GradeRenderer';
import { gradeToCssFilter } from '../color/cssFilter';
import { GradeParams, isNeutral } from '../color/types';

export interface ViewerHandle {
  resetView: () => void;
  redraw: () => void;
}

export type OverlayKind = 'select' | 'tracking' | 'stabilized';

/** Pulled fresh on every render frame so playback/analysis stay smooth
 * without re-rendering React each frame. */
export interface ViewerProviders {
  stabilize?: () => Affine;
  tracking?: () => { points: Point[]; ok: boolean; trails?: Point[][]; cloud?: Point[] };
  pins?: () => Point[];
  exportRect?: () => Rect | null;
  safeRect?: () => Rect | null;
}

interface Props {
  /** the shared <video> element (created/owned by App, adopted here) */
  video: HTMLVideoElement;
  /** where to return the video element on unmount */
  home: HTMLElement | null;
  meta: VideoMeta;
  mode: TrackMode;
  overlay: OverlayKind;
  providers?: ViewerProviders;
  points: Point[];
  onPointsChange?: (pts: Point[]) => void;
  /** per-zone sampling radius in source px (select mode) */
  radii?: number[];
  onRadiusChange?: (index: number, r: number) => void;
  interactiveZoom?: boolean;
  onCropMove?: (dx: number, dy: number) => void;
  onCropResize?: (corner: number, x: number, y: number) => void;
  /** when set, the view is zoomed to this crop rect (final cropped result,
   * filling the container) and overlays are hidden */
  cropView?: Rect | null;
  /** color grade — shown here as a CSS-filter approximation so the look is
   * visible in every preview (faithful render is in the Color editor/export) */
  grade?: GradeParams;
}

const DRAG_THRESHOLD = 6;

export const Viewer = forwardRef<ViewerHandle, Props>(function Viewer(
  {
    video,
    home,
    meta,
    mode,
    overlay,
    providers,
    points,
    onPointsChange,
    radii,
    onRadiusChange,
    interactiveZoom = true,
    onCropMove,
    onCropResize,
    cropView,
    grade,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef({ zoom: 1, panX: 0, panY: 0 });
  const overlayRef = useRef(overlay);
  const pointsRef = useRef(points);
  const radiiRef = useRef(radii);
  const cropViewRef = useRef(cropView);
  const providersRef = useRef(providers);
  const gradeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const graderRef = useRef<GradeRenderer | null>(null);
  const gradeRef = useRef<GradeParams | undefined>(grade);
  const frameRef = useRef(0);
  overlayRef.current = overlay;
  cropViewRef.current = cropView;
  pointsRef.current = points;
  radiiRef.current = radii;
  providersRef.current = providers;
  gradeRef.current = grade;

  const pointers = useRef<Map<number, Point>>(new Map());
  const gesture = useRef({
    mode: 'none' as 'none' | 'pan' | 'pinch' | 'drag' | 'radius' | 'crop-move' | 'crop-resize',
    dragIndex: -1,
    radiusZone: -1,
    cornerIndex: -1,
    lastSrc: { x: 0, y: 0 } as Point,
    startDist: 0,
    startZoom: 1,
    moved: false,
    downPos: { x: 0, y: 0 } as Point,
  });

  const dpr = () => Math.min(window.devicePixelRatio || 1, 2.5);

  /* Adopt the shared <video> node into our container, return it home on unmount. */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    video.style.position = 'absolute';
    video.style.left = '0';
    video.style.top = '0';
    video.style.transformOrigin = '0 0';
    video.style.willChange = 'transform';
    video.style.pointerEvents = 'none';
    video.style.opacity = '1';
    container.insertBefore(video, container.firstChild);
    return () => {
      if (home) {
        video.style.opacity = '0';
        home.appendChild(video);
      }
    };
  }, [video, home]);

  /* keep the video element sized to source pixels (transform handles the rest) */
  useEffect(() => {
    video.style.width = `${meta.width}px`;
    video.style.height = `${meta.height}px`;
  }, [video, meta.width, meta.height]);

  /* Faithful grade overlay: a WebGL canvas laid exactly over the native video,
   * textured from the video frame and run through the SAME shader as the export
   * (so the preview is WYSIWYG, not a CSS approximation). Falls back to a CSS
   * filter on the native video if WebGL2 is unavailable. */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const gc = document.createElement('canvas');
    gc.style.position = 'absolute';
    gc.style.left = '0';
    gc.style.top = '0';
    gc.style.transformOrigin = '0 0';
    gc.style.willChange = 'transform';
    gc.style.pointerEvents = 'none';
    gc.style.display = 'none';
    gc.width = meta.width;
    gc.height = meta.height;
    gc.style.width = `${meta.width}px`;
    gc.style.height = `${meta.height}px`;
    // sit just above the native video, below the overlay (markers) canvas
    container.insertBefore(gc, canvasRef.current);
    gradeCanvasRef.current = gc;
    try {
      graderRef.current = new GradeRenderer(gc);
    } catch {
      graderRef.current = null; // CSS-filter fallback handled in render()
    }
    return () => {
      graderRef.current?.dispose();
      graderRef.current = null;
      gc.remove();
      gradeCanvasRef.current = null;
      video.style.opacity = '1';
      video.style.filter = 'none';
    };
  }, [video, meta.width, meta.height]);

  const layout = useCallback(() => {
    const rect = containerRef.current!.getBoundingClientRect();
    const ratio = dpr();
    const cv = cropViewRef.current;
    // when cropView is set, fit/center the CROP rect (final result fills view);
    // otherwise fit the full frame
    const fitW = cv ? cv.w : meta.width;
    const fitH = cv ? cv.h : meta.height;
    const offX = cv ? cv.x : 0;
    const offY = cv ? cv.y : 0;
    const fitCss = Math.min(rect.width / fitW, rect.height / fitH);
    const baseCss = fitCss * view.current.zoom;
    const originXcss = (rect.width - fitW * baseCss) / 2 - offX * baseCss + view.current.panX;
    const originYcss = (rect.height - fitH * baseCss) / 2 - offY * baseCss + view.current.panY;
    return { rect, ratio, baseCss, originXcss, originYcss };
  }, [meta.width, meta.height]);

  const toDisplay = useCallback(
    (p: Point): Point => {
      const { ratio, baseCss, originXcss, originYcss } = layout();
      return { x: (originXcss + p.x * baseCss) * ratio, y: (originYcss + p.y * baseCss) * ratio };
    },
    [layout]
  );

  const fromClient = useCallback(
    (clientX: number, clientY: number): Point => {
      const { rect, baseCss, originXcss, originYcss } = layout();
      return {
        x: (clientX - rect.left - originXcss) / baseCss,
        y: (clientY - rect.top - originYcss) / baseCss,
      };
    },
    [layout]
  );

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const { rect, ratio, baseCss, originXcss, originYcss } = layout();
    const cw = rect.width * ratio;
    const ch = rect.height * ratio;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const ov = overlayRef.current;
    const prov = providersRef.current;

    // Position/transform the native video (CSS px). In stabilized mode we warp
    // the video itself with the stabilization affine; otherwise it's raw.
    const viewCss: Affine = [baseCss, 0, originXcss, 0, baseCss, originYcss];
    const stab = ov === 'stabilized' && prov?.stabilize ? prov.stabilize() : IDENTITY;
    const m = compose(stab, viewCss); // apply stabilize (source->output) then view
    const matrix = `matrix(${m[0]}, ${m[3]}, ${m[1]}, ${m[4]}, ${m[2]}, ${m[5]})`;
    video.style.transform = matrix;

    // Faithful grade: render the video frame through the export shader onto the
    // overlay canvas and place it exactly over the (now hidden) native video.
    const g = gradeRef.current;
    const gc = gradeCanvasRef.current;
    const grader = graderRef.current;
    if (gc) {
      const neutral = !g || isNeutral(g);
      if (neutral || video.readyState < 2) {
        gc.style.display = 'none';
        video.style.opacity = '1';
        video.style.filter = !neutral && !grader && g ? gradeToCssFilter(g) : 'none';
      } else if (grader) {
        // full-frame preview: drop letterbox (the crop box conveys framing)
        const pg = g.letterbox ? { ...g, letterbox: 0 } : g;
        grader.render(video, meta.width, meta.height, pg, frameRef.current++);
        gc.style.transform = matrix;
        gc.style.display = 'block';
        video.style.opacity = '0';
        video.style.filter = 'none';
      } else {
        gc.style.display = 'none';
        video.style.opacity = '1';
        video.style.filter = gradeToCssFilter(g);
      }
    }

    // crop-view = final cropped result fills the view, no overlays drawn
    if (cropViewRef.current) return;

    // Overlays (device px), mapped by the view only (output space).
    if (ov === 'select') {
      // zone sampling circles (the area features are picked from)
      const rds = radiiRef.current ?? [];
      const sc = baseCss * ratio; // source px → device px
      ctx.lineWidth = 2 * ratio;
      pointsRef.current.forEach((p, i) => {
        const c = toDisplay(p);
        const rDev = Math.max(6, (rds[i] ?? 40) * sc);
        ctx.strokeStyle = 'rgba(25,240,200,0.85)';
        ctx.setLineDash([6 * ratio, 5 * ratio]);
        ctx.beginPath();
        ctx.arc(c.x, c.y, rDev, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(25,240,200,0.10)';
        ctx.fill();
        ctx.fillStyle = '#19f0c8'; // radius handle on the right edge
        ctx.beginPath();
        ctx.arc(c.x + rDev, c.y, 6 * ratio, 0, Math.PI * 2);
        ctx.fill();
      });
      drawTrackingOverlay(ctx, pointsRef.current, { toDisplay, ok: true, scale: ratio });
    } else if (ov === 'tracking' && prov?.tracking) {
      const t = prov.tracking();
      drawTrackingOverlay(ctx, t.points, {
        toDisplay,
        ok: t.ok,
        trails: t.trails,
        cloud: t.cloud,
        scale: ratio,
      });
    } else if (ov === 'stabilized') {
      const crop = prov?.exportRect?.() ?? null;
      if (crop) drawExportFrame(ctx, crop, toDisplay, cw, ch, ratio, prov?.safeRect?.() ?? null);
      const pins = prov?.pins?.();
      if (pins && pins.length) drawPins(ctx, pins, toDisplay, ratio);
    }
  }, [layout, toDisplay, video]);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      render();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [render]);

  useImperativeHandle(ref, () => ({
    resetView: () => {
      view.current = { zoom: 1, panX: 0, panY: 0 };
    },
    redraw: render,
  }));

  /* ----------------------------- gestures ----------------------------- */

  const clampPan = () => {
    // keep at least part of the frame on screen so the view can't get lost
    const { rect, baseCss } = layout();
    const halfW = (meta.width * baseCss) / 2;
    const halfH = (meta.height * baseCss) / 2;
    const maxX = halfW + rect.width / 2;
    const maxY = halfH + rect.height / 2;
    view.current.panX = Math.max(-maxX, Math.min(maxX, view.current.panX));
    view.current.panY = Math.max(-maxY, Math.min(maxY, view.current.panY));
  };

  const nearestPoint = (p: Point): number => {
    const { baseCss } = layout();
    const tol = 32 / baseCss; // ~32 css px tolerance, in source units
    let best = -1;
    let bestD = Infinity;
    pointsRef.current.forEach((q, i) => {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return bestD <= tol ? best : -1;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    g.moved = false;
    g.downPos = { x: e.clientX, y: e.clientY };

    if (pointers.current.size === 2 && interactiveZoom) {
      const [a, b] = [...pointers.current.values()];
      g.mode = 'pinch';
      g.startDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      g.startZoom = view.current.zoom;
      return;
    }

    const src = fromClient(e.clientX, e.clientY);

    if (overlayRef.current === 'select' && onPointsChange) {
      const { baseCss } = layout();
      const centerTol = 30 / baseCss;
      const edgeTol = 22 / baseCss;
      const pts = pointsRef.current;
      const rds = radiiRef.current ?? [];
      // 1) move a point if near its center
      let ci = -1;
      let cb = centerTol;
      pts.forEach((q, i) => {
        const d = Math.hypot(q.x - src.x, q.y - src.y);
        if (d < cb) {
          cb = d;
          ci = i;
        }
      });
      if (ci >= 0) {
        g.mode = 'drag';
        g.dragIndex = ci;
        return;
      }
      // 2) resize a zone if near its circle edge
      if (onRadiusChange) {
        let ri = -1;
        let rb = edgeTol;
        pts.forEach((q, i) => {
          const d = Math.abs(Math.hypot(q.x - src.x, q.y - src.y) - (rds[i] ?? 40));
          if (d < rb) {
            rb = d;
            ri = i;
          }
        });
        if (ri >= 0) {
          g.mode = 'radius';
          g.radiusZone = ri;
          return;
        }
      }
    }

    if (overlayRef.current === 'stabilized' && onCropMove) {
      const rect = providersRef.current?.exportRect?.();
      if (rect) {
        const { baseCss } = layout();
        const tol = 26 / baseCss;
        const corners = [
          { x: rect.x, y: rect.y },
          { x: rect.x + rect.w, y: rect.y },
          { x: rect.x + rect.w, y: rect.y + rect.h },
          { x: rect.x, y: rect.y + rect.h },
        ];
        let ci = -1;
        let bd = tol;
        corners.forEach((c, i) => {
          const d = Math.hypot(c.x - src.x, c.y - src.y);
          if (d < bd) {
            bd = d;
            ci = i;
          }
        });
        if (ci >= 0 && onCropResize) {
          g.mode = 'crop-resize';
          g.cornerIndex = ci;
          return;
        }
        if (src.x >= rect.x && src.x <= rect.x + rect.w && src.y >= rect.y && src.y <= rect.y + rect.h) {
          g.mode = 'crop-move';
          g.lastSrc = src;
          return;
        }
      }
    }

    g.mode = 'pan';
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId)!;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (Math.hypot(e.clientX - g.downPos.x, e.clientY - g.downPos.y) > DRAG_THRESHOLD) {
      g.moved = true;
    }

    if (g.mode === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      view.current.zoom = Math.min(8, Math.max(1, g.startZoom * (dist / g.startDist)));
      if (view.current.zoom <= 1.001) {
        view.current.panX = 0;
        view.current.panY = 0;
      }
      clampPan();
      return;
    }

    if (g.mode === 'crop-resize' && onCropResize) {
      const src = fromClient(e.clientX, e.clientY);
      onCropResize(g.cornerIndex, src.x, src.y);
      return;
    }

    if (g.mode === 'crop-move' && onCropMove) {
      const src = fromClient(e.clientX, e.clientY);
      onCropMove(src.x - g.lastSrc.x, src.y - g.lastSrc.y);
      g.lastSrc = src;
      return;
    }

    if (g.mode === 'radius' && onRadiusChange) {
      const src = fromClient(e.clientX, e.clientY);
      const a = pointsRef.current[g.radiusZone];
      if (a) {
        const r = Math.hypot(src.x - a.x, src.y - a.y);
        const maxR = Math.min(meta.width, meta.height) / 2;
        onRadiusChange(g.radiusZone, Math.max(10, Math.min(maxR, r)));
      }
      return;
    }

    if (g.mode === 'drag' && onPointsChange) {
      const src = fromClient(e.clientX, e.clientY);
      const pts = pointsRef.current.map((p, i) =>
        i === g.dragIndex
          ? { x: Math.min(meta.width, Math.max(0, src.x)), y: Math.min(meta.height, Math.max(0, src.y)) }
          : p
      );
      onPointsChange(pts);
      return;
    }

    if (g.mode === 'pan' && interactiveZoom) {
      view.current.panX += e.clientX - prev.x;
      view.current.panY += e.clientY - prev.y;
      clampPan();
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    pointers.current.delete(e.pointerId);

    // place a point only on a tap in empty space (not on a point/handle)
    if (g.mode === 'pan' && !g.moved && overlayRef.current === 'select' && onPointsChange) {
      const src = fromClient(e.clientX, e.clientY);
      if (src.x >= 0 && src.x <= meta.width && src.y >= 0 && src.y <= meta.height) {
        placePoint(src);
      }
    }
    // recompute mode from whatever pointers remain
    if (pointers.current.size === 0) g.mode = 'none';
    else if (pointers.current.size === 1) g.mode = 'pan';
  };

  const placePoint = (src: Point) => {
    if (!onPointsChange) return;
    const max = mode === 'two' ? 2 : 1;
    const pts = [...pointsRef.current];
    const near = nearestPoint(src);
    if (near >= 0) pts[near] = src;
    else if (pts.length < max) pts.push(src);
    else {
      let best = 0;
      let bestD = Infinity;
      pts.forEach((q, i) => {
        const d = Math.hypot(q.x - src.x, q.y - src.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      pts[best] = src;
    }
    onPointsChange(pts);
  };

  return (
    <div ref={containerRef} className="viewer-stage">
      <canvas
        ref={canvasRef}
        className="viewer-canvas"
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  );
});
