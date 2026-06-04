import MP4Box from 'mp4box';

/** Original AAC audio track extracted (not decoded) from the source file, so it
 * can be copied straight into the output MP4 — no re-encoding. This is the only
 * reliable way to keep audio on iOS (no AudioEncoder/captureStream needed). */
export interface CopiedAudio {
  sampleRate: number;
  channels: number;
  description: Uint8Array; // AAC AudioSpecificConfig
  samples: { data: Uint8Array; timestampUs: number; durationUs: number }[];
}

const FREQ_INDEX = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Build a 2-byte AAC-LC AudioSpecificConfig from sample rate + channel count. */
function makeAsc(sampleRate: number, channels: number): Uint8Array {
  let idx = FREQ_INDEX.indexOf(sampleRate);
  if (idx < 0) idx = 4; // default 44100
  const objectType = 2; // AAC LC
  const b0 = (objectType << 3) | (idx >> 1);
  const b1 = ((idx & 1) << 7) | (channels << 3);
  return new Uint8Array([b0, b1]);
}

export function extractAacTrack(fileBuffer: ArrayBuffer): Promise<CopiedAudio | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: CopiedAudio | null) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const mp4: any = MP4Box.createFile();
      let track: any = null;
      const samples: any[] = [];

      mp4.onError = (e: any) => {
        console.warn('[remux] mp4box error', e);
        finish(null);
      };
      mp4.onReady = (info: any) => {
        track = info.audioTracks && info.audioTracks[0];
        if (!track || !/mp4a/i.test(track.codec || '')) {
          console.warn('[remux] no AAC audio track (codec:', track?.codec, ')');
          return finish(null);
        }
        mp4.setExtractionOptions(track.id, null, { nbSamples: Number.MAX_SAFE_INTEGER });
        mp4.onSamples = (_id: number, _u: any, arr: any[]) => {
          for (const s of arr) samples.push(s);
        };
        mp4.start();
      };

      const buf = fileBuffer.slice(0) as any;
      buf.fileStart = 0;
      mp4.appendBuffer(buf);
      mp4.flush();

      // sample callbacks fire during flush; collect on the next tick
      setTimeout(() => {
        if (!track || !samples.length) {
          console.warn('[remux] no samples extracted');
          return finish(null);
        }
        const sampleRate = track.audio?.sample_rate || 44100;
        const channels = track.audio?.channel_count || 2;
        const out = samples.map((s) => ({
          data: new Uint8Array(s.data),
          timestampUs: (s.cts / s.timescale) * 1e6,
          durationUs: (s.duration / s.timescale) * 1e6,
        }));
        console.log('[remux] extracted', out.length, 'AAC samples', sampleRate, 'Hz', channels, 'ch');
        finish({ sampleRate, channels, description: makeAsc(sampleRate, channels), samples: out });
      }, 0);
    } catch (e) {
      console.warn('[remux] failed', e);
      finish(null);
    }
  });
}

/** Feed copied AAC samples (within [start,end]) straight into an mp4-muxer. */
export function muxCopiedAudio(
  copied: CopiedAudio,
  muxer: any,
  start: number,
  end: number,
  signal?: AbortSignal
): number {
  const EAC = (window as any).EncodedAudioChunk;
  if (typeof EAC !== 'function') return 0;
  const startUs = start * 1e6;
  const endUs = end * 1e6;
  let count = 0;
  let first = true;
  for (const s of copied.samples) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (s.timestampUs < startUs - 1000 || s.timestampUs > endUs) continue;
    const chunk = new EAC({
      type: 'key',
      timestamp: Math.round(s.timestampUs - startUs),
      duration: Math.round(s.durationUs),
      data: s.data,
    });
    muxer.addAudioChunk(
      chunk,
      first
        ? {
            decoderConfig: {
              codec: 'mp4a.40.2',
              sampleRate: copied.sampleRate,
              numberOfChannels: copied.channels,
              description: copied.description,
            },
          }
        : undefined
    );
    first = false;
    count++;
  }
  return count;
}
