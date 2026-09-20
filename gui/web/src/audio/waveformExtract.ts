/** PCM / WAV → uint8 peak bins. Pure — Vitest-friendly, worker-callable. */

export type ExtractPeaksResult = {
  peaks: Uint8Array;
  binsPerSec: number;
  startSec: number;
  endSec: number;
};

export function pcmToUint8Peaks(
  pcm: Float32Array,
  sampleRate: number,
  binsPerSec: number,
): Uint8Array {
  if (!(sampleRate > 0) || !(binsPerSec > 0) || pcm.length === 0) {
    return new Uint8Array(0);
  }
  const spp = Math.max(1, Math.round(sampleRate / binsPerSec));
  const n = Math.max(1, Math.floor(pcm.length / spp));
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const lo = i * spp;
    const hi = lo + spp;
    let peak = 0;
    for (let s = lo; s < hi; s++) {
      const v = pcm[s] ?? 0;
      const a = v < 0 ? -v : v;
      if (a > peak) {
        peak = a;
      }
    }
    out[i] = Math.max(0, Math.min(255, Math.round(peak * 255)));
  }
  return out;
}

export function extractPeaksFromPcm(
  pcm: Float32Array,
  sampleRate: number,
  binsPerSec: number,
  startSec: number,
): ExtractPeaksResult {
  const peaks = pcmToUint8Peaks(pcm, sampleRate, binsPerSec);
  const duration = pcm.length / sampleRate;
  return {
    peaks,
    binsPerSec,
    startSec,
    endSec: startSec + duration,
  };
}

/** Slice extract into idle-sized chunks; abort via signal. */
export function extractPeaksIdle(
  pcm: Float32Array,
  sampleRate: number,
  binsPerSec: number,
  startSec: number,
  signal?: AbortSignal,
): Promise<ExtractPeaksResult> {
  if (typeof requestIdleCallback === "undefined") {
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    return Promise.resolve(
      extractPeaksFromPcm(pcm, sampleRate, binsPerSec, startSec),
    );
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const spp = Math.max(1, Math.round(sampleRate / binsPerSec));
    const n = Math.max(1, Math.floor(pcm.length / spp));
    const out = new Uint8Array(n);
    let i = 0;
    const chunk = Math.max(32, Math.floor(n / 16) || 32);
    const step = () => {
      if (signal?.aborted) {
        return;
      }
      const end = Math.min(n, i + chunk);
      for (; i < end; i++) {
        const lo = i * spp;
        const hi = lo + spp;
        let peak = 0;
        for (let s = lo; s < hi; s++) {
          const v = pcm[s] ?? 0;
          const a = v < 0 ? -v : v;
          if (a > peak) {
            peak = a;
          }
        }
        out[i] = Math.max(0, Math.min(255, Math.round(peak * 255)));
      }
      if (i >= n) {
        signal?.removeEventListener("abort", onAbort);
        resolve({
          peaks: out,
          binsPerSec,
          startSec,
          endSec: startSec + pcm.length / sampleRate,
        });
        return;
      }
      requestIdleCallback(step);
    };
    requestIdleCallback(step);
  });
}
