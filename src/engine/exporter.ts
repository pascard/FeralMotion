import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { AnalysisResult, trackAt } from './analysis';
import { constrainToCrop } from './stabilizer';
import { extractAacTrack, muxCopiedAudio, CopiedAudio } from './audioRemux';
import { seekTo } from './videoFrames';
import { Rect, VideoMeta } from './types';
import { makeComposite } from '../color/composite';
import { GradeParams, NEUTRAL } from '../color/types';

export interface ExportParams {
  video: HTMLVideoElement;
  meta: VideoMeta;
  result: AnalysisResult;
  /** chosen export crop rect, in source/output pixels */
  crop: Rect;
  /** color grade applied on top of the stabilized + cropped frame */
  grade?: GradeParams;
  /** export time range (defaults to the analyzed range) */
  start?: number;
  end?: number;
  /** original file bytes, used to recover the audio track */
  fileBuffer?: ArrayBuffer;
  onProgress?: (ratio: number, stage: string) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  ext: string;
  mime: string;
  engine: 'webcodecs' | 'mediarecorder';
}

const AVC_CANDIDATES = [
  'avc1.640033',
  'avc1.640028',
  'avc1.4d0028',
  'avc1.42e01f',
];

function bitrateFor(w: number, h: number, fps: number): number {
  const bpp = 0.3; // bits per pixel·frame -> near-source, clean quality
  return Math.min(80_000_000, Math.max(12_000_000, Math.round(w * h * fps * bpp)));
}

export function canUseWebCodecs(): boolean {
  return typeof (window as any).VideoEncoder === 'function' && typeof VideoFrame === 'function';
}

/** Best-effort detection of whether the source actually has an audio track. */
function hasAudioTrack(video: HTMLVideoElement): boolean {
  const v = video as any;
  if (typeof v.webkitAudioDecodedByteCount === 'number' && v.webkitAudioDecodedByteCount > 0) return true;
  if (v.audioTracks && typeof v.audioTracks.length === 'number') return v.audioTracks.length > 0;
  if (typeof v.mozHasAudio === 'boolean') return v.mozHasAudio;
  return true; // unknown → assume yes, so we never silently drop audio
}

export async function exportStabilized(params: ExportParams): Promise<ExportResult> {
  if (canUseWebCodecs()) {
    try {
      return await exportWebCodecs(params);
    } catch (err) {
      if ((err as any)?.name === 'AbortError') throw err;
      if ((err as Error)?.message === 'AUDIO_FALLBACK') {
        console.log('[export] AAC encode unavailable → MediaRecorder (keeps original audio)');
      } else {
        console.warn('[export] WebCodecs failed, falling back to MediaRecorder', err);
      }
    }
  }
  return exportMediaRecorder(params);
}

async function pickAvcCodec(w: number, h: number, fps: number) {
  const bitrate = bitrateFor(w, h, fps);
  for (const codec of AVC_CANDIDATES) {
    try {
      const sup = await (window as any).VideoEncoder.isConfigSupported({
        codec,
        width: w,
        height: h,
        bitrate,
        framerate: fps,
      });
      if (sup.supported) return { codec, bitrate };
    } catch {
      /* try next */
    }
  }
  return { codec: AVC_CANDIDATES[AVC_CANDIDATES.length - 1], bitrate };
}

async function exportWebCodecs(params: ExportParams): Promise<ExportResult> {
  const { video, meta, result, crop, fileBuffer, onProgress, signal } = params;
  const grade = params.grade ?? NEUTRAL;
  const fps = meta.fps;
  const dt = 1 / fps;
  const start = Math.max(result.start, params.start ?? result.start);
  const end = Math.min(result.end, params.end ?? result.end);
  const totalFrames = Math.max(1, Math.round((end - start) * fps) + 1);

  const renderer = makeComposite(meta, crop);
  const w = renderer.outW;
  const h = renderer.outH;

  try {
  // AUDIO STRATEGY (best → worst):
  //  1) copy the original AAC track verbatim via mp4box (no re-encode; the only
  //     reliable path on iOS — no AudioEncoder/captureStream needed),
  //  2) re-encode decoded PCM to AAC via WebCodecs AudioEncoder,
  //  3) else throw → MediaRecorder fallback (keeps original track natively).
  const wantAudio = hasAudioTrack(video);
  let copied: CopiedAudio | null = null;
  let plan: AudioPlan | null = null;
  if (fileBuffer) {
    copied = await extractAacTrack(fileBuffer);
    if (!copied) {
      const audio = await decodeAudioSlice(fileBuffer, start, end);
      plan = audio ? await planAudio(audio) : null;
    }
  }
  console.log('[export] WebCodecs path. wantAudio=%s copiedAAC=%s aacPlan=%s', wantAudio, !!copied, !!plan);
  if (wantAudio && !copied && !plan) {
    throw new Error('AUDIO_FALLBACK');
  }

  const audioCfg = copied
    ? { codec: 'aac' as const, sampleRate: copied.sampleRate, numberOfChannels: copied.channels }
    : plan
    ? { codec: 'aac' as const, sampleRate: plan.sampleRate, numberOfChannels: plan.channels }
    : undefined;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: w, height: h },
    audio: audioCfg,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  const { codec, bitrate } = await pickAvcCodec(w, h, fps);
  const encoder = new (window as any).VideoEncoder({
    output: (chunk: any, m: any) => muxer.addVideoChunk(chunk, m),
    error: (e: any) => console.error('VideoEncoder error', e),
  });
  encoder.configure({
    codec,
    width: w,
    height: h,
    bitrate,
    framerate: fps,
    latencyMode: 'quality',
  });

  for (let i = 0; i < totalFrames; i++) {
    if (signal?.aborted) {
      encoder.close();
      throw new DOMException('aborted', 'AbortError');
    }
    const t = Math.min(end, start + i * dt);
    await seekTo(video, t);
    const stab = constrainToCrop(trackAt(result, t).stabilize, crop, meta.width, meta.height);
    renderer.draw(video, stab, grade, i);

    const frame = new VideoFrame(renderer.canvas, {
      timestamp: Math.round(i * dt * 1e6),
      duration: Math.round(dt * 1e6),
    });
    encoder.encode(frame, { keyFrame: i % Math.round(fps) === 0 });
    frame.close();
    onProgress?.((i / totalFrames) * 0.9, 'Encoding video');
    // keep the encoder queue bounded so memory stays sane on mobile
    if (encoder.encodeQueueSize > 8) await waitQueue(encoder);
  }

  await encoder.flush();
  encoder.close();

  if (copied) {
    onProgress?.(0.92, 'Audio (copy)');
    const n = muxCopiedAudio(copied, muxer, start, end, signal);
    console.log('[export] copied AAC samples muxed:', n);
    if (n === 0 && wantAudio) throw new Error('AUDIO_FALLBACK');
  } else if (plan) {
    onProgress?.(0.92, 'Encoding audio');
    const n = await encodeAudioPlan(plan, muxer, signal);
    console.log('[export] audio chunks muxed:', n);
    if (n === 0 && wantAudio) throw new Error('AUDIO_FALLBACK');
  }

  onProgress?.(0.98, 'Finalizing');
  muxer.finalize();
  const { buffer } = muxer.target as ArrayBufferTarget;
  onProgress?.(1, 'Done');
  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    ext: 'mp4',
    mime: 'video/mp4',
    engine: 'webcodecs',
  };
  } finally {
    renderer.dispose(); // free the WebGL2 context (scarce — never leak)
  }
}

function waitQueue(encoder: any): Promise<void> {
  return new Promise((r) => {
    const check = () => (encoder.encodeQueueSize <= 4 ? r() : setTimeout(check, 5));
    check();
  });
}

interface DecodedAudio {
  sampleRate: number;
  channels: number;
  data: Float32Array[]; // per-channel planar PCM
  frames: number;
}

async function decodeAudioSlice(
  fileBuffer: ArrayBuffer,
  start: number,
  end: number
): Promise<DecodedAudio | null> {
  try {
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ac = new AC();
    const buf = await ac.decodeAudioData(fileBuffer.slice(0));
    ac.close();
    const sr = buf.sampleRate;
    const s = Math.floor(start * sr);
    const e = Math.min(buf.length, Math.ceil(end * sr));
    const frames = Math.max(0, e - s);
    if (frames === 0) return null;
    const channels = buf.numberOfChannels;
    const data: Float32Array[] = [];
    for (let ch = 0; ch < channels; ch++) {
      data.push(buf.getChannelData(ch).slice(s, e));
    }
    console.log('[export] audio decoded:', channels, 'ch', sr, 'Hz', frames, 'frames');
    return { sampleRate: sr, channels, data, frames };
  } catch (err) {
    console.warn('[export] decodeAudioData failed (export sans son)', err);
    return null;
  }
}

interface AudioPlan {
  sampleRate: number;
  channels: number;
  data: Float32Array[]; // planar PCM
  frames: number;
}

/** Plan AAC audio for MP4 if the device can encode it. We deliberately do NOT
 * fall back to Opus-in-MP4 here: it muxes but often won't play in mobile
 * galleries. When AAC is unavailable the caller switches to MediaRecorder,
 * which keeps the original (already-AAC) audio track natively. */
async function planAudio(audio: DecodedAudio): Promise<AudioPlan | null> {
  const AE = (window as any).AudioEncoder;
  if (typeof AE !== 'function') return null;
  try {
    const r = await AE.isConfigSupported({
      codec: 'mp4a.40.2',
      sampleRate: audio.sampleRate,
      numberOfChannels: audio.channels,
      bitrate: 192_000,
    });
    if (!r?.supported) {
      console.log('[export] AAC encode unsupported on this device');
      return null;
    }
  } catch {
    return null;
  }
  console.log('[export] audio codec: AAC', audio.sampleRate, 'Hz', audio.channels, 'ch');
  return { sampleRate: audio.sampleRate, channels: audio.channels, data: audio.data, frames: audio.frames };
}

/** Encode the planned audio as AAC into the muxer. Returns the chunk count. */
async function encodeAudioPlan(plan: AudioPlan, muxer: any, signal?: AbortSignal): Promise<number> {
  let count = 0;
  await new Promise<void>((resolve, reject) => {
    const encoder = new (window as any).AudioEncoder({
      output: (chunk: any, m: any) => {
        count++;
        muxer.addAudioChunk(chunk, m);
      },
      error: reject,
    });
    encoder.configure({
      codec: 'mp4a.40.2',
      sampleRate: plan.sampleRate,
      numberOfChannels: plan.channels,
      bitrate: 192_000,
    });

    const chunk = 4096;
    for (let off = 0; off < plan.frames; off += chunk) {
      if (signal?.aborted) {
        encoder.close();
        return reject(new DOMException('aborted', 'AbortError'));
      }
      const n = Math.min(chunk, plan.frames - off);
      const planar = new Float32Array(plan.channels * n);
      for (let ch = 0; ch < plan.channels; ch++) {
        planar.set(plan.data[ch].subarray(off, off + n), ch * n);
      }
      const ad = new (window as any).AudioData({
        format: 'f32-planar',
        sampleRate: plan.sampleRate,
        numberOfFrames: n,
        numberOfChannels: plan.channels,
        timestamp: Math.round((off / plan.sampleRate) * 1e6),
        data: planar,
      });
      encoder.encode(ad);
      ad.close();
    }
    encoder.flush().then(
      () => {
        encoder.close();
        resolve();
      },
      reject
    );
  });
  return count;
}

/* ----------------------- MediaRecorder fallback ----------------------- */

async function exportMediaRecorder(params: ExportParams): Promise<ExportResult> {
  const { video, meta, result, crop, onProgress, signal } = params;
  const start = Math.max(result.start, params.start ?? result.start);
  const end = Math.min(result.end, params.end ?? result.end);

  const grade = params.grade ?? NEUTRAL;
  const renderer = makeComposite(meta, crop);
  const w = renderer.outW;
  const h = renderer.outH;
  const canvas = renderer.canvas;

  try {
  const mime = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')
    ? 'video/mp4;codecs=avc1'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';

  const stream = canvas.captureStream(meta.fps);
  // Pull the original audio track in so the story keeps its sound. Unmute and
  // briefly play BEFORE capturing so the audio track is live and not silent.
  let audioCaptured = false;
  try {
    video.muted = false;
    (video as any).volume = 1;
    await video.play().catch(() => {});
    const vStream = (video as any).captureStream?.() || (video as any).mozCaptureStream?.();
    const aTrack = vStream?.getAudioTracks?.()[0];
    if (aTrack) {
      stream.addTrack(aTrack);
      audioCaptured = true;
    }
  } catch (e) {
    console.warn('[export] could not capture original audio track', e);
  }
  console.log('[export] MediaRecorder path. mime=%s audioTrack=%s', mime, audioCaptured);

  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: bitrateFor(w, h, meta.fps),
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
  });

  video.currentTime = start;
  await seekTo(video, start);
  recorder.start();
  video.muted = false;
  await video.play();

  await new Promise<void>((resolve) => {
    const anyVid = video as any;
    const draw = () => {
      if (signal?.aborted || video.currentTime >= end) {
        resolve();
        return;
      }
      const stab = constrainToCrop(trackAt(result, video.currentTime).stabilize, crop, meta.width, meta.height);
      renderer.draw(video, stab, grade, video.currentTime * meta.fps);
      onProgress?.(
        Math.min(0.99, (video.currentTime - start) / (end - start)),
        'Recording'
      );
      if (typeof anyVid.requestVideoFrameCallback === 'function') {
        anyVid.requestVideoFrameCallback(draw);
      } else {
        requestAnimationFrame(draw);
      }
    };
    if (typeof anyVid.requestVideoFrameCallback === 'function') {
      anyVid.requestVideoFrameCallback(draw);
    } else {
      requestAnimationFrame(draw);
    }
  });

  video.pause();
  recorder.stop();
  const blob = await done;
  onProgress?.(1, 'Done');
  return { blob, ext, mime, engine: 'mediarecorder' };
  } finally {
    renderer.dispose(); // free the WebGL2 context (scarce — never leak)
  }
}
