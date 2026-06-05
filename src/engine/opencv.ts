// Loads OpenCV.js on demand and resolves when the runtime is ready.
// Served locally from public/opencv.js (self-contained UMD build with the wasm
// embedded as base64). No external CDN dependency / rate limits.
// Source: npm @techstark/opencv-js@4.10.0-release.1.
const OPENCV_URL = `${import.meta.env.BASE_URL}opencv.js`;

let loadPromise: Promise<void> | null = null;

/** Returns the live OpenCV module. Only valid after `loadOpenCV()` resolves.
 * Read synchronously — never `await` it: the module is a self-referential
 * thenable and awaiting/returning it spins an infinite microtask loop that
 * freezes the main thread. */
export function getCV(): any {
  return window.cv;
}

/** Loads OpenCV and resolves with VOID once it's ready. Use getCV() afterwards. */
export function loadOpenCV(onProgress?: (ratio: number) => void): Promise<void> {
  if (window.cv && window.__opencvReady) return Promise.resolve();
  if (loadPromise) return loadPromise;

  // IMPORTANT: this chain must never resolve/return/await the OpenCV module.
  loadPromise = (async () => {
    await download(onProgress);
    await injectScript();
    await resolveModule();
    await waitForApi();
    window.__opencvReady = true;
    console.log('[opencv] runtime ready');
    // deliberately return nothing — see getCV()
  })();

  loadPromise.catch(() => {
    loadPromise = null;
  });
  return loadPromise;
}

let cachedBlobUrl: string | null = null;

async function download(onProgress?: (ratio: number) => void) {
  const res = await fetch(OPENCV_URL);
  if (!res.ok) throw new Error(`OpenCV download failed (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total && onProgress) onProgress(Math.min(1, received / total));
  }
  if (!total && onProgress) onProgress(1);
  console.log('[opencv] downloaded', (received / 1e6).toFixed(1), 'MB, evaluating…');
  cachedBlobUrl = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: 'text/javascript' }));
}

function injectScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = cachedBlobUrl!;
    script.async = true;
    script.onload = () => {
      console.log('[opencv] script evaluated');
      resolve();
    };
    script.onerror = () => reject(new Error('Could not run OpenCV.js.'));
    document.head.appendChild(script);
  });
}

/** If window.cv is a (possibly self-referential) thenable, consume it safely
 * and store the resulting module back on window.cv — resolving our control
 * promise with a primitive, never the module. */
function resolveModule(): Promise<void> {
  const cv = window.cv;
  if (!cv) return Promise.reject(new Error('OpenCV not found after loading.'));
  if (typeof cv.then !== 'function' || cv.Mat) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    cv.then((mod: any) => {
      if (settled) return;
      settled = true;
      if (mod) window.cv = mod;
      resolve(); // primitive — no thenable adoption
    });
    // safety: if .then never fires, fall back to polling in waitForApi
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    }, 8000);
  });
}

/** Wait until the OpenCV API (cv.Mat) is usable. */
function waitForApi(timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.cv && window.cv.Mat) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve();
    };
    if (window.cv) window.cv.onRuntimeInitialized = finish;
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (window.cv && window.cv.Mat) finish();
      else if (Date.now() - t0 > timeoutMs) {
        clearInterval(poll);
        reject(new Error('OpenCV initialization timed out (30s).'));
      }
    }, 50);
  });
}

export function isOpenCVReady(): boolean {
  return !!(window.cv && window.__opencvReady);
}
