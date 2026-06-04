import { useCallback, useEffect, useRef, useState } from 'react';
import { makeComposite } from '../color/composite';
import { LOOKS } from '../color/presets';
import { GradeParams, ToneMap, cloneParams } from '../color/types';
import { analyzeFrame, autoExposure, autoWhiteBalance } from '../color/analyze';
import { AnalysisResult, trackAt } from '../engine/analysis';
import { constrainToCrop } from '../engine/stabilizer';
import { IDENTITY, Rect, VideoMeta } from '../engine/types';

interface Props {
  video: HTMLVideoElement;
  home: HTMLElement | null;
  meta: VideoMeta;
  /** stabilization context (null = color-only, identity transform) */
  analysis: AnalysisResult | null;
  crop: Rect;
  start: number;
  end: number;
  grade: GradeParams;
  onGradeChange: (g: GradeParams) => void;
  onBack: () => void;
  onExport: () => void;
}

const SLIDERS: { key: keyof GradeParams; label: string; min: number; max: number; step: number }[] = [
  { key: 'exposure', label: 'Exposition', min: -2, max: 2, step: 0.01 },
  { key: 'contrast', label: 'Contraste', min: -1, max: 1, step: 0.01 },
  { key: 'temp', label: 'Température', min: -1, max: 1, step: 0.01 },
  { key: 'tint', label: 'Teinte', min: -1, max: 1, step: 0.01 },
  { key: 'shadows', label: 'Ombres', min: -1, max: 1, step: 0.01 },
  { key: 'highlights', label: 'Hautes lum.', min: -1, max: 1, step: 0.01 },
  { key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.01 },
  { key: 'vibrance', label: 'Vibrance', min: -1, max: 1, step: 0.01 },
  { key: 'tealOrange', label: 'Teal & Orange', min: 0, max: 1, step: 0.01 },
  { key: 'fade', label: 'Faded', min: 0, max: 1, step: 0.01 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01 },
  { key: 'grain', label: 'Grain', min: 0, max: 1, step: 0.01 },
];

const TONEMAPS = [
  { v: ToneMap.None, label: 'Aucun' },
  { v: ToneMap.Reinhard, label: 'Doux' },
  { v: ToneMap.ACES, label: 'Filmique' },
  { v: ToneMap.Hable, label: 'Argentique' },
];

const RATIOS = [
  { v: 0, label: 'Plein' },
  { v: 2.39, label: '2.39' },
  { v: 1.85, label: '1.85' },
  { v: 16 / 9, label: '16:9' },
  { v: 1, label: '1:1' },
];

export function ColorEditor({
  video,
  home,
  meta,
  analysis,
  crop,
  start,
  end,
  grade,
  onGradeChange,
  onBack,
  onExport,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const gradeRef = useRef(grade);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(start);
  gradeRef.current = grade;

  // adopt the shared video (kept in DOM so it decodes), build the composite,
  // and run the preview render loop
  useEffect(() => {
    const wrap = wrapRef.current!;
    video.style.position = 'absolute';
    video.style.inset = '0';
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'contain';
    video.style.opacity = '0.01';
    video.style.pointerEvents = 'none';
    wrap.insertBefore(video, wrap.firstChild);

    const comp = makeComposite(meta, crop);
    const canvas = comp.canvas as HTMLCanvasElement;
    canvas.className = 'color-canvas';
    wrap.appendChild(canvas);

    let raf = 0;
    let frame = 0;
    const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
    const loop = () => {
      const t = video.currentTime;
      const stab = analysis
        ? constrainToCrop(trackAt(analysis, t).stabilize, crop, meta.width, meta.height)
        : [...IDENTITY] as any;
      comp.draw(video, stab, gradeRef.current, frame++);
      // size the output canvas to fit the wrap (contain)
      const rect = wrap.getBoundingClientRect();
      const scale = Math.min(rect.width / comp.outW, rect.height / comp.outH) || 0;
      canvas.style.width = `${comp.outW * scale}px`;
      canvas.style.height = `${comp.outH * scale}px`;
      // loop within range
      if (!video.paused && video.currentTime >= end - 0.05) video.currentTime = start;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // start near the range start
    if (video.currentTime < start || video.currentTime > end) video.currentTime = start;

    return () => {
      cancelAnimationFrame(raf);
      comp.dispose();
      canvas.remove();
      if (home) home.appendChild(video);
    };
    // depend on crop VALUES (not object identity) so re-grading never rebuilds
    // the WebGL context (which would exhaust GL contexts and crash)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, home, meta, analysis, start, end, crop.x, crop.y, crop.w, crop.h]);

  // lightweight current-time ticker for the scrub bar
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = () => {
      const now = performance.now();
      if (now - last > 90) {
        setCurrent(video.currentTime);
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [video]);

  const setParam = useCallback(
    <K extends keyof GradeParams>(k: K, v: GradeParams[K]) => {
      onGradeChange({ ...gradeRef.current, [k]: v });
    },
    [onGradeChange]
  );

  const togglePlay = useCallback(async () => {
    if (video.paused) {
      video.muted = true;
      if (video.currentTime < start || video.currentTime >= end - 0.05) video.currentTime = start;
      try {
        await video.play();
        setPlaying(true);
      } catch {
        /* ignore */
      }
    } else {
      video.pause();
      setPlaying(false);
    }
  }, [video, start, end]);

  const auto = useCallback(() => {
    try {
      const s = analyzeFrame(video);
      onGradeChange({
        ...gradeRef.current,
        exposure: autoExposure(s),
        ...autoWhiteBalance(s),
      });
    } catch {
      /* ignore */
    }
  }, [video, onGradeChange]);

  return (
    <>
      <div className="viewer-wrap" ref={wrapRef} />

      <div className="color-transport">
        <button className="round" onClick={togglePlay}>
          {playing ? '❚❚' : '►'}
        </button>
        <input
          type="range"
          min={start}
          max={end}
          step={0.01}
          value={Math.min(Math.max(current, start), end)}
          onChange={(e) => {
            const t = parseFloat(e.target.value);
            video.currentTime = t;
            setCurrent(t);
          }}
        />
      </div>

      <div className="controls column color-panel">
        <div className="format-chips">
          {LOOKS.map((l) => (
            <button key={l.id} className="chip" onClick={() => onGradeChange(cloneParams(l.params))}>
              {l.label}
            </button>
          ))}
        </div>

        <button className="ghost" onClick={auto}>
          ✨ Auto exposition + balance
        </button>

        <div className="color-sliders">
          {SLIDERS.map((s) => (
            <div className="slider-row" key={s.key}>
              <span>{s.label}</span>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={grade[s.key] as number}
                onChange={(e) => setParam(s.key, parseFloat(e.target.value) as any)}
              />
              <span className="mono">{(grade[s.key] as number).toFixed(2)}</span>
            </div>
          ))}
        </div>

        <div className="seg-row">
          <span className="row-label">Tone map</span>
          <div className="seg">
            {TONEMAPS.map((t) => (
              <button
                key={t.v}
                className={grade.toneMap === t.v ? 'on' : ''}
                onClick={() => setParam('toneMap', t.v)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="seg-row">
          <span className="row-label">Format</span>
          <div className="seg">
            {RATIOS.map((r) => (
              <button
                key={r.label}
                className={Math.abs(grade.letterbox - r.v) < 0.01 ? 'on' : ''}
                onClick={() => setParam('letterbox', r.v)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="controls">
          <button className="round" onClick={togglePlay}>
            {playing ? '❚❚' : '►'}
          </button>
          <button className="ghost" onClick={onBack}>
            ↤ Retour
          </button>
          <button className="primary grow" onClick={onExport}>
            Exporter
          </button>
        </div>
      </div>
    </>
  );
}
