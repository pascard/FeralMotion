import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Viewer, ViewerHandle, ViewerProviders, OverlayKind } from './ui/Viewer';
import { Timeline } from './ui/Timeline';
import { loadOpenCV, getCV } from './engine/opencv';
import { AnalysisResult, analyzeStabilization, recomputeTracks, trackAt } from './engine/analysis';
import { exportStabilized, canUseWebCodecs } from './engine/exporter';
import { seekTo, probeVideo, waitForVideoReady } from './engine/videoFrames';
import { computeSafeRect, fitAspect, moveRect, resizeRect, lerpRect, FORMATS } from './engine/crop';
import { constrainToCrop } from './engine/stabilizer';
import { PRECISIONS, DEFAULT_PRECISION, getPreset } from './engine/presets';
import { IDENTITY, Point, Rect, TrackMode, VideoMeta } from './engine/types';

type Step = 'import' | 'loading' | 'ready' | 'points' | 'analyzing' | 'edit' | 'export';

const TRAIL_LEN = 14;

export default function App() {
  // The <video> is created once and owned imperatively so it can be moved
  // between a hidden holder and the Viewer without React remounting it (which
  // would interrupt decoding). Mobile won't decode a display:none video.
  const [videoEl] = useState<HTMLVideoElement>(() => {
    const v = document.createElement('video');
    v.playsInline = true;
    v.muted = true;
    v.preload = 'auto';
    v.setAttribute('playsinline', 'true');
    v.setAttribute('webkit-playsinline', 'true');
    v.crossOrigin = 'anonymous';
    return v;
  });
  const homeRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<File>();
  const [videoURL, setVideoURL] = useState<string>();
  const [meta, setMeta] = useState<VideoMeta>();
  const [step, setStep] = useState<Step>('import');
  const [mode, setMode] = useState<TrackMode>('one');
  const [refPoints, setRefPoints] = useState<Point[]>([]);
  const [zoneRadii, setZoneRadii] = useState<number[]>([]);
  const [trim, setTrim] = useState({ start: 0, end: 0 });
  const [smoothing, setSmoothing] = useState(6);
  const [precision, setPrecision] = useState(DEFAULT_PRECISION);
  const [formatId, setFormatId] = useState('max');
  const [expand, setExpand] = useState(0); // 0 = max stable (safe) .. 1 = full frame
  const [cropRect, setCropRect] = useState<Rect | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [cvProgress, setCvProgress] = useState<number | null>(null);
  const [exportState, setExportState] = useState<{ ratio: number; stage: string } | null>(null);
  const [exportUrl, setExportUrl] = useState<string>();
  const [showRaw, setShowRaw] = useState(false);
  const [error, setError] = useState<string>();
  const [nativeFs, setNativeFs] = useState(false);
  const [immersive, setImmersive] = useState(false); // CSS fallback (iOS, no FS API)
  // iOS Safari/Chrome (WebKit) can't fullscreen arbitrary elements
  const fsSupported =
    typeof document !== 'undefined' &&
    (document.fullscreenEnabled || (document as any).webkitFullscreenEnabled);

  useEffect(() => {
    const onFs = () =>
      setNativeFs(!!(document.fullscreenElement || (document as any).webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs as any);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('webkitfullscreenchange', onFs as any);
    };
  }, []);

  const isFullscreen = nativeFs || immersive;

  const toggleFullscreen = useCallback(() => {
    const d: any = document;
    if (fsSupported) {
      if (!d.fullscreenElement && !d.webkitFullscreenElement) {
        const el: any = document.documentElement;
        (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
      } else {
        (d.exitFullscreen || d.webkitExitFullscreen)?.call(d);
      }
    } else {
      // CSS-immersive fallback (best we can do on iOS web)
      setImmersive((v) => !v);
    }
  }, [fsSupported]);

  const viewerRef = useRef<ViewerHandle>(null);
  const analysisRef = useRef<AnalysisResult | null>(null);
  const currentRef = useRef(0);
  const cropRectRef = useRef<Rect | null>(null);
  const safeRectRef = useRef<Rect | null>(null);
  const metaRef = useRef<VideoMeta | undefined>(undefined);
  const expandRef = useRef(expand);
  const stepRef = useRef(step);
  const trimRef = useRef(trim);
  metaRef.current = meta;
  expandRef.current = expand;
  stepRef.current = step;
  const showRawRef = useRef(showRaw);
  const liveTrackRef = useRef<{ points: Point[]; ok: boolean; trails: Point[][]; cloud: Point[] }>({
    points: [],
    ok: true,
    trails: [],
    cloud: [],
  });
  const trailHist = useRef<Point[][]>([]);
  const abortRef = useRef<AbortController | null>(null);

  cropRectRef.current = cropRect;
  trimRef.current = trim;
  showRawRef.current = showRaw;

  const need = mode === 'two' ? 2 : 1;

  /* park the video in the hidden holder until the Viewer adopts it */
  useEffect(() => {
    if (homeRef.current && !videoEl.parentElement) homeRef.current.appendChild(videoEl);
  }, [videoEl]);

  /* load the chosen source */
  useEffect(() => {
    if (!videoURL) return;
    videoEl.src = videoURL;
    videoEl.load();
  }, [videoEl, videoURL]);

  const stopVideo = useCallback(() => {
    try {
      videoEl.pause();
    } catch {
      /* ignore */
    }
    setPlaying(false);
  }, [videoEl]);

  /* --------------------------- load & probe --------------------------- */
  useEffect(() => {
    if (!videoEl || !videoURL) return;
    let cancelled = false;
    (async () => {
      try {
        const m = await probeVideo(videoEl);
        if (cancelled) return;
        setMeta(m);
        setTrim({ start: 0, end: m.duration });
        setStep('ready');
        // Generate thumbnails on a SEPARATE video element so it never fights
        // the main element for currentTime during analysis/preview.
        if (videoURL) genThumbs(videoURL, m).then((t) => !cancelled && setThumbs(t));
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setStep('import');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoEl, videoURL]);

  /* ------------------------- playback ticker -------------------------- */
  useEffect(() => {
    if (!videoEl) return;
    let raf = 0;
    let lastUI = 0;
    const tick = () => {
      currentRef.current = videoEl.currentTime;
      const now = performance.now();
      if (now - lastUI > 80) {
        setCurrent(videoEl.currentTime);
        lastUI = now;
      }
      // loop within the trimmed range only during preview (not during export,
      // which drives the element itself)
      if (!videoEl.paused && (stepRef.current === 'edit' || stepRef.current === 'ready')) {
        const { start, end } = trimRef.current;
        if (videoEl.currentTime >= end - 0.03) videoEl.currentTime = start;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoEl]);

  const providers = useMemo<ViewerProviders>(
    () => ({
      stabilize: () => {
        if (showRawRef.current) return IDENTITY;
        const a = analysisRef.current;
        if (!a) return IDENTITY;
        const raw = trackAt(a, currentRef.current).stabilize;
        const crop = cropRectRef.current;
        const m = metaRef.current;
        // constrain so an oversized crop "hits the borders" instead of black
        return crop && m ? constrainToCrop(raw, crop, m.width, m.height) : raw;
      },
      // preview always shows the FULL stabilized frame; the export crop is drawn
      // as an overlay box so the user sees the available bounds vs the chosen frame.
      tracking: () => liveTrackRef.current,
      pins: () => (showRawRef.current ? [] : analysisRef.current?.ref ?? []),
      exportRect: () => (showRawRef.current ? null : cropRectRef.current),
      safeRect: () => (showRawRef.current ? null : safeRectRef.current),
    }),
    []
  );

  /* ------------------------------ actions ----------------------------- */

  const handleFile = useCallback((picked: File) => {
    setError(undefined);
    setStep('loading'); // show loader immediately; probe runs in the effect below
    setFile(picked);
    // Don't read the whole file now (slow on mobile for big videos) — the audio
    // bytes are read lazily at export time.
    setVideoURL((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(picked);
    });
  }, []);

  const onSeek = useCallback(
    (t: number) => {
      if (!videoEl) return;
      videoEl.currentTime = t;
      currentRef.current = t;
      setCurrent(t);
    },
    [videoEl]
  );

  const togglePlay = useCallback(async () => {
    if (!videoEl) return;
    if (videoEl.paused) {
      if (videoEl.currentTime < trim.start || videoEl.currentTime >= trim.end - 0.03) {
        videoEl.currentTime = trim.start;
      }
      videoEl.muted = step === 'analyzing';
      try {
        await videoEl.play();
        setPlaying(true);
      } catch {
        /* ignored */
      }
    } else {
      videoEl.pause();
      setPlaying(false);
    }
  }, [videoEl, trim, step]);

  const startStabilize = useCallback(async () => {
    if (!videoEl) return;
    setPlaying(false);
    setRefPoints([]);
    setZoneRadii([]);
    viewerRef.current?.resetView();
    // Prime the decoder with a gesture-backed muted play/pause so the paused
    // frame is actually decoded and drawable on mobile (avoids a black canvas).
    try {
      videoEl.muted = true;
      await videoEl.play();
      videoEl.pause();
    } catch {
      /* ignore */
    }
    onSeek(trim.start);
    setStep('points');
  }, [videoEl, trim.start, onSeek]);

  const defaultRadius = useMemo(() => {
    if (!meta) return 40;
    return Math.round((getPreset(precision).radius * Math.min(meta.width, meta.height)) / 720);
  }, [precision, meta]);

  const handlePointsChange = useCallback(
    (pts: Point[]) => {
      setRefPoints(pts);
      setZoneRadii((prev) => pts.map((_, i) => prev[i] ?? defaultRadius));
    },
    [defaultRadius]
  );

  const onRadiusChange = useCallback((i: number, r: number) => {
    setZoneRadii((prev) => prev.map((v, k) => (k === i ? r : v)));
  }, []);

  const changeMode = useCallback((m: TrackMode) => {
    setMode(m);
    const max = m === 'two' ? 2 : 1;
    setRefPoints((pts) => pts.slice(0, max));
    setZoneRadii((rs) => rs.slice(0, max));
  }, []);

  // Recompute coverage (safe area) for the current stabilization and re-fit the
  // chosen format's crop rect inside it.
  // crop for a given format + expand amount: lerp between the safe rect (max
  // stable) and the full frame (plein cadre), both fitted to the aspect.
  const cropForExpand = useCallback((fmtId: string, t: number): Rect | null => {
    const safe = safeRectRef.current;
    const m = metaRef.current;
    if (!safe || !m) return null;
    const ratio = FORMATS.find((f) => f.id === fmtId)?.ratio ?? 0;
    const frame: Rect = { x: 0, y: 0, w: m.width, h: m.height };
    return lerpRect(fitAspect(safe, ratio), fitAspect(frame, ratio), t);
  }, []);

  const refitCrop = useCallback(
    (fmtId: string) => {
      if (!analysisRef.current || !meta) return;
      // max usable frame = source frame minus the (smoothed) movement extent,
      // computed over the CURRENT trimmed range only
      const tr = trimRef.current;
      safeRectRef.current = computeSafeRect(analysisRef.current, meta.width, meta.height, tr.start, tr.end);
      const rect = cropForExpand(fmtId, expandRef.current);
      if (rect) {
        cropRectRef.current = rect;
        setCropRect(rect);
      }
    },
    [meta, cropForExpand]
  );

  const selectFormat = useCallback(
    (id: string) => {
      setFormatId(id);
      refitCrop(id);
    },
    [refitCrop]
  );

  const onExpand = useCallback(
    (t: number) => {
      setExpand(t);
      expandRef.current = t;
      const rect = cropForExpand(formatId, t);
      if (rect) {
        cropRectRef.current = rect;
        setCropRect(rect);
      }
    },
    [formatId, cropForExpand]
  );

  // Re-derive the stabilization from already-tracked points at a new smoothing
  // radius — instant, no optical-flow re-run. Preview reads analysisRef live.
  const changeSmoothing = useCallback(
    (v: number) => {
      setSmoothing(v);
      if (analysisRef.current) {
        analysisRef.current = recomputeTracks(analysisRef.current, v);
        refitCrop(formatId); // coverage changed with smoothing
      }
    },
    [formatId, refitCrop]
  );

  // crop may exceed the safe area (up to the full video frame); going past safe
  // turns the frame orange and makes stabilization hit the borders.
  const frameRect = useCallback((): Rect => {
    const m = metaRef.current;
    return { x: 0, y: 0, w: m?.width ?? 1, h: m?.height ?? 1 };
  }, []);

  const onCropMove = useCallback(
    (dx: number, dy: number) => {
      if (!cropRectRef.current) return;
      const r = moveRect(frameRect(), cropRectRef.current, dx, dy);
      cropRectRef.current = r;
      setCropRect(r);
    },
    [frameRect]
  );

  const onCropResize = useCallback(
    (corner: number, x: number, y: number) => {
      if (!cropRectRef.current) return;
      const r = resizeRect(frameRect(), cropRectRef.current, corner, x, y);
      cropRectRef.current = r;
      setCropRect(r);
    },
    [frameRect]
  );

  const runAnalysis = useCallback(async () => {
    if (!videoEl || !meta) return;
    stopVideo();
    viewerRef.current?.resetView(); // reset zoom/pan during the tracking pass
    setStep('analyzing');
    setAnalysisProgress(0);
    trailHist.current = refPoints.map(() => []);
    try {
      console.log('[runAnalysis] requesting OpenCV…');
      await loadOpenCV((r) => setCvProgress(r));
      const cv = getCV(); // read synchronously — never await the module
      console.log('[runAnalysis] OpenCV resolved. Mat=%s Size=%s calcOpticalFlowPyrLK=%s',
        !!cv?.Mat, typeof cv?.Size, typeof cv?.calcOpticalFlowPyrLK);
      setCvProgress(null);
      // let the UI repaint before the (synchronous-ish) analysis setup
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      const abort = new AbortController();
      abortRef.current = abort;
      console.log('[runAnalysis] launching analysis…', {
        mode, refPoints, start: trim.start, end: trim.end,
        w: meta.width, h: meta.height, fps: meta.fps,
      });
      const result = await analyzeStabilization({
        cv,
        video: videoEl,
        meta,
        mode,
        refPoints,
        start: trim.start,
        end: trim.end,
        smoothing,
        precision,
        radii: zoneRadii,
        onFrame: ({ index, total, points, cloud, ok }) => {
          points.forEach((p, i) => {
            const h = trailHist.current[i] ?? (trailHist.current[i] = []);
            h.push(p);
            if (h.length > TRAIL_LEN) h.shift();
          });
          liveTrackRef.current = {
            points,
            ok,
            cloud,
            trails: trailHist.current.map((h) => [...h]),
          };
          setAnalysisProgress(total ? index / total : 0);
        },
        signal: abort.signal,
      });
      console.log('[runAnalysis] analysis complete:', result.tracks.length, 'frames');
      analysisRef.current = result;
      refitCrop(formatId); // compute safe area + initial export frame
      setShowRaw(false);
      viewerRef.current?.resetView();
      onSeek(trim.start);
      setStep('edit');
    } catch (e) {
      console.error('[runAnalysis] FAILED', e);
      if ((e as any)?.name !== 'AbortError') {
        setError('Échec de l’analyse : ' + (e as Error).message);
      }
      setStep('points');
    } finally {
      setCvProgress(null);
    }
  }, [videoEl, meta, mode, refPoints, zoneRadii, trim, onSeek, smoothing, precision, refitCrop, formatId, stopVideo]);

  const runExport = useCallback(async () => {
    if (!videoEl || !meta || !analysisRef.current) return;
    videoEl.pause();
    setPlaying(false);
    setExportUrl(undefined);
    setStep('export');
    setExportState({ ratio: 0, stage: 'Préparation' });
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      // read the audio bytes lazily (kept out of the import path for speed)
      let fileBuffer: ArrayBuffer | undefined;
      try {
        fileBuffer = file ? await file.arrayBuffer() : undefined;
      } catch {
        fileBuffer = undefined;
      }
      console.log(
        '[export] start: file=%s size=%s type=%s webcodecs=%s',
        !!file, file?.size, file?.type, canUseWebCodecs()
      );
      const res = await exportStabilized({
        video: videoEl,
        meta,
        result: analysisRef.current,
        crop: cropRectRef.current ?? { x: 0, y: 0, w: meta.width, h: meta.height },
        start: trim.start,
        end: trim.end,
        fileBuffer,
        onProgress: (ratio, stage) => setExportState({ ratio, stage }),
        signal: abort.signal,
      });
      setExportUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(res.blob);
      });
      setExportState({ ratio: 1, stage: 'Terminé' });
    } catch (e) {
      if ((e as any)?.name !== 'AbortError') {
        setError('Échec de l’export : ' + (e as Error).message);
      }
      setStep('edit');
    }
  }, [videoEl, meta, file, trim]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    analysisRef.current = null;
    cropRectRef.current = null;
    safeRectRef.current = null;
    // fully stop the old video so its audio can't keep playing
    try {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
    } catch {
      /* ignore */
    }
    setPlaying(false);
    setVideoURL((old) => {
      if (old) URL.revokeObjectURL(old);
      return undefined;
    });
    setFile(undefined);
    setStep('import');
    setMeta(undefined);
    setRefPoints([]);
    setZoneRadii([]);
    setExpand(0);
    setCropRect(null);
    setThumbs([]);
    setExportUrl(undefined);
    setExportState(null);
    setError(undefined);
  }, [videoEl]);

  /* ------------------------------ render ------------------------------ */

  const overlay: OverlayKind =
    step === 'points'
      ? 'select'
      : step === 'analyzing'
      ? 'tracking'
      : step === 'edit' || step === 'export'
      ? 'stabilized'
      : 'select';

  return (
    <div className={`app ${immersive ? 'immersive' : ''}`}>
      {/* Hidden holder that "parks" the shared <video> element when the Viewer
          isn't mounted. The Viewer adopts the node so it's never re-created
          (which would interrupt decoding) and is shown natively (no canvas
          copy → never black on mobile). */}
      <div
        ref={homeRef}
        aria-hidden
        style={{
          position: 'fixed',
          left: -10000,
          top: 0,
          width: 240,
          height: 135,
          overflow: 'hidden',
          opacity: 0,
          pointerEvents: 'none',
        }}
      />

      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" /> FeralMotion
        </div>
        <div className="topbar-actions">
          {meta && step !== 'import' && (
            <button className="ghost" onClick={reset}>
              Nouvelle vidéo
            </button>
          )}
          <button className="icon-btn" onClick={toggleFullscreen} aria-label="Plein écran">
            {isFullscreen ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            )}
          </button>
        </div>
      </header>

      <main className="stage">
        {step === 'import' && <ImportScreen onFile={handleFile} error={error} />}

        {step === 'loading' && (
          <div className="loader-screen">
            <div className="spinner" />
            <p>Préparation de la vidéo…</p>
          </div>
        )}

        {meta && videoEl && step !== 'import' && (
          <>
            <div className="viewer-wrap">
              {step === 'export' && exportUrl ? (
                // finished export: play the actual result video (looping)
                <video
                  className="result-video"
                  src={exportUrl}
                  autoPlay
                  loop
                  muted
                  playsInline
                  controls
                />
              ) : (
                <Viewer
                  ref={viewerRef}
                  video={videoEl}
                  home={homeRef.current}
                  meta={meta}
                  mode={mode}
                  overlay={overlay}
                  providers={providers}
                  points={refPoints}
                  onPointsChange={step === 'points' ? handlePointsChange : undefined}
                  radii={zoneRadii}
                  onRadiusChange={step === 'points' ? onRadiusChange : undefined}
                  interactiveZoom={step === 'points' || step === 'edit'}
                  onCropMove={step === 'edit' ? onCropMove : undefined}
                  onCropResize={step === 'edit' ? onCropResize : undefined}
                  cropView={step === 'export' ? cropRect : null}
                />
              )}

              {step === 'analyzing' && (
                <div className="analyze-badge">
                  <span className="pulse" />{' '}
                  {cvProgress !== null
                    ? `Chargement du moteur… ${Math.round(cvProgress * 100)}%`
                    : `Suivi en cours… ${Math.round(analysisProgress * 100)}%`}
                </div>
              )}
              {step === 'edit' && (
                <button
                  className="compare-btn"
                  onPointerDown={() => setShowRaw(true)}
                  onPointerUp={() => setShowRaw(false)}
                  onPointerLeave={() => setShowRaw(false)}
                >
                  {showRaw ? 'Original' : 'Maintenir : comparer'}
                </button>
              )}
              {step === 'export' && !exportUrl && (
                <div className="analyze-badge">
                  <span className="pulse" /> Export… {Math.round((exportState?.ratio ?? 0) * 100)}%
                </div>
              )}
            </div>

            {/* timeline visible from ready onward */}
            {(step === 'ready' || step === 'edit') && (
              <Timeline
                duration={meta.duration}
                start={trim.start}
                end={trim.end}
                current={current}
                thumbs={thumbs}
                onTrim={(s, e) => {
                  if (step === 'edit' && analysisRef.current) {
                    // in edit you can only SHRINK within the analyzed range;
                    // recompute the max usable frame for the new range
                    const a = analysisRef.current;
                    const nt = { start: Math.max(a.start, s), end: Math.min(a.end, e) };
                    setTrim(nt);
                    trimRef.current = nt;
                    refitCrop(formatId);
                  } else {
                    setTrim({ start: s, end: e });
                  }
                }}
                onSeek={onSeek}
              />
            )}

            <Controls
              step={step}
              mode={mode}
              need={need}
              placed={refPoints.length}
              playing={playing}
              smoothing={smoothing}
              precision={precision}
              formatId={formatId}
              expand={expand}
              cropRect={cropRect}
              analysisProgress={analysisProgress}
              cvProgress={cvProgress}
              exportState={exportState}
              exportUrl={exportUrl}
              webcodecs={canUseWebCodecs()}
              onTogglePlay={togglePlay}
              onChangeMode={changeMode}
              onStartStabilize={startStabilize}
              onAnalyze={runAnalysis}
              onExport={runExport}
              onSelectFormat={selectFormat}
              onSelectPrecision={setPrecision}
              onExpand={onExpand}
              onSmoothing={changeSmoothing}
              onBackToPoints={() => {
                stopVideo();
                setStep('points');
              }}
              onBackToLength={() => {
                stopVideo();
                setStep('ready');
              }}
              onCancel={() => {
                abortRef.current?.abort();
                stopVideo();
                setStep(step === 'export' ? 'edit' : 'points');
              }}
              onReset={reset}
            />
          </>
        )}
        {error && step !== 'import' && <div className="error-toast">{error}</div>}
      </main>
    </div>
  );
}

/* --------------------------- sub components --------------------------- */

function ImportScreen({ onFile, error }: { onFile: (f: File) => void; error?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <div
      className={`import ${drag ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
    >
      <div className="import-card">
        <div className="import-icon">🎬</div>
        <h1>Stabilise ta vidéo</h1>
        <p>1 ou 2 points de suivi. Idéal pour une story bien stable.</p>
        <button className="primary big" onClick={() => inputRef.current?.click()}>
          Importer une vidéo
        </button>
        <span className="hint">ou glisse-dépose un fichier ici</span>
        {error && <div className="error-toast">{error}</div>}
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
      </div>
    </div>
  );
}

interface ControlsProps {
  step: Step;
  mode: TrackMode;
  need: number;
  placed: number;
  playing: boolean;
  smoothing: number;
  precision: string;
  formatId: string;
  expand: number;
  cropRect: Rect | null;
  analysisProgress: number;
  cvProgress: number | null;
  exportState: { ratio: number; stage: string } | null;
  exportUrl?: string;
  webcodecs: boolean;
  onTogglePlay: () => void;
  onChangeMode: (m: TrackMode) => void;
  onStartStabilize: () => void;
  onAnalyze: () => void;
  onExport: () => void;
  onSelectFormat: (id: string) => void;
  onSelectPrecision: (id: string) => void;
  onExpand: (v: number) => void;
  onSmoothing: (v: number) => void;
  onBackToPoints: () => void;
  onBackToLength: () => void;
  onCancel: () => void;
  onReset: () => void;
}

function Controls(p: ControlsProps) {
  if (p.step === 'ready') {
    return (
      <div className="controls">
        <button className="round" onClick={p.onTogglePlay}>
          {p.playing ? '❚❚' : '►'}
        </button>
        <button className="primary grow" onClick={p.onStartStabilize}>
          ✦ Stabiliser
        </button>
      </div>
    );
  }

  if (p.step === 'points') {
    return (
      <div className="controls column">
        <div className="seg">
          <button className={p.mode === 'one' ? 'on' : ''} onClick={() => p.onChangeMode('one')}>
            1 zone
            <small>translation</small>
          </button>
          <button className={p.mode === 'two' ? 'on' : ''} onClick={() => p.onChangeMode('two')}>
            2 zones
            <small>+ rotation / échelle</small>
          </button>
        </div>
        <div className="format-row">
          <span className="row-label">Puissance</span>
          <div className="format-chips">
            {PRECISIONS.map((pr) => (
              <button
                key={pr.id}
                className={p.precision === pr.id ? 'chip on' : 'chip'}
                onClick={() => p.onSelectPrecision(pr.id)}
                title={pr.hint}
              >
                {pr.label}
              </button>
            ))}
          </div>
        </div>
        <p className="tip">
          {p.placed < p.need
            ? `Touche la vidéo pour placer ${p.need === 2 ? `la zone ${p.placed + 1}/2` : 'la zone'} · pince pour zoomer`
            : 'Glisse le centre pour déplacer, le bord du cercle pour régler la zone d’analyse. Puis analyse.'}
        </p>
        <div className="controls">
          <button className="ghost" onClick={p.onReset}>
            Annuler
          </button>
          <button className="primary grow" disabled={p.placed < p.need} onClick={p.onAnalyze}>
            Analyser le suivi →
          </button>
        </div>
      </div>
    );
  }

  if (p.step === 'analyzing') {
    return (
      <div className="controls column">
        {p.cvProgress !== null ? (
          <p className="tip">Chargement du moteur de tracking… {Math.round(p.cvProgress * 100)}%</p>
        ) : (
          <Progress ratio={p.analysisProgress} label="Analyse du mouvement" />
        )}
        <button className="ghost" onClick={p.onCancel}>
          Annuler
        </button>
      </div>
    );
  }

  if (p.step === 'edit') {
    return (
      <div className="controls column">
        <div className="slider-row">
          <span>Lissage</span>
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={p.smoothing}
            onChange={(e) => p.onSmoothing(parseInt(e.target.value, 10))}
          />
          <span className="mono">
            {p.smoothing === 0 ? 'Figé' : p.smoothing >= 22 ? 'Max' : p.smoothing >= 12 ? 'Fort' : `±${p.smoothing}`}
          </span>
        </div>
        <div className="format-row">
          <div className="format-chips">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                className={p.formatId === f.id ? 'chip on' : 'chip'}
                onClick={() => p.onSelectFormat(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {p.cropRect && (
            <span className="mono crop-dims">
              {Math.round(p.cropRect.w)}×{Math.round(p.cropRect.h)}
            </span>
          )}
        </div>
        <div className="slider-row">
          <span>Cadrage</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={p.expand}
            onChange={(e) => p.onExpand(parseFloat(e.target.value))}
          />
          <span className="mono">{p.expand <= 0.01 ? 'Stable' : p.expand >= 0.99 ? 'Plein' : `${Math.round(p.expand * 100)}%`}</span>
        </div>
        <p className="tip">
          Glisse le cadre · agrandis-le au-delà de la zone sûre (cadre orange) pour rogner moins,
          la stabilisation viendra buter sur les bords. Réduis la durée ci-dessus.
        </p>
        <div className="controls">
          <button className="round" onClick={p.onTogglePlay}>
            {p.playing ? '❚❚' : '►'}
          </button>
          <button className="ghost" onClick={p.onBackToLength}>
            ↤ Durée
          </button>
          <button className="ghost" onClick={p.onBackToPoints}>
            ↺ Points
          </button>
          <button className="primary grow" onClick={p.onExport}>
            Exporter
          </button>
        </div>
      </div>
    );
  }

  if (p.step === 'export') {
    return (
      <div className="controls column">
        {p.exportUrl ? (
          <>
            <p className="tip success">✓ Vidéo stabilisée prête.</p>
            <div className="controls">
              <a className="primary grow center" href={p.exportUrl} download="feralmotion.mp4">
                Télécharger
              </a>
              <button className="ghost" onClick={p.onCancel}>
                Retour
              </button>
            </div>
          </>
        ) : (
          <>
            <Progress
              ratio={p.exportState?.ratio ?? 0}
              label={`${p.exportState?.stage ?? 'Export'} · ${
                p.webcodecs ? 'WebCodecs' : 'MediaRecorder'
              }`}
            />
            <button className="ghost" onClick={p.onCancel}>
              Annuler
            </button>
          </>
        )}
      </div>
    );
  }
  return null;
}

function Progress({ ratio, label }: { ratio: number; label: string }) {
  return (
    <div className="progress">
      <div className="progress-label">
        <span>{label}</span>
        <span className="mono">{Math.round(ratio * 100)}%</span>
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
    </div>
  );
}

/* ----------------------------- helpers ----------------------------- */

async function genThumbs(url: string, meta: VideoMeta): Promise<string[]> {
  const N = 12;
  const h = 64;
  const w = Math.max(1, Math.round((h * meta.width) / meta.height));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const out: string[] = [];

  const v = document.createElement('video');
  v.src = url;
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  try {
    await waitForVideoReady(v);
    for (let i = 0; i < N; i++) {
      const t = (meta.duration * (i + 0.5)) / N;
      await seekTo(v, t);
      ctx.drawImage(v, 0, 0, w, h);
      out.push(c.toDataURL('image/jpeg', 0.5));
    }
  } catch {
    /* thumbnails are best-effort */
  } finally {
    v.src = '';
    v.load();
  }
  return out;
}
