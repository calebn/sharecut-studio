import { extractPeaksFromPcm, extractPeaksIdle } from "./waveformExtract";

export type WorkerExtractMsg = {
  type: "extract";
  id: string;
  pcm: Float32Array;
  sampleRate: number;
  binsPerSec: number;
  startSec: number;
};

export type WorkerAbortMsg = { type: "abort"; id: string };

export type WorkerResultMsg = {
  type: "result";
  id: string;
  peaks: Uint8Array;
  binsPerSec: number;
  startSec: number;
  endSec: number;
};

export type WorkerErrorMsg = { type: "error"; id: string; message: string };

let worker: Worker | null | undefined;
const pending = new Map<
  string,
  {
    resolve: (peaks: Uint8Array) => void;
    reject: (err: Error) => void;
  }
>();
let seq = 0;

function getWorker(): Worker | null {
  if (worker !== undefined) {
    return worker;
  }
  if (typeof Worker === "undefined") {
    worker = null;
    return null;
  }
  try {
    worker = new Worker(new URL("./waveformWorker.entry.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (ev: MessageEvent<WorkerResultMsg | WorkerErrorMsg>) => {
      const data = ev.data;
      const slot = pending.get(data.id);
      if (!slot) {
        return;
      }
      pending.delete(data.id);
      if (data.type === "result") {
        slot.resolve(data.peaks);
      } else {
        slot.reject(new Error(data.message));
      }
    };
  } catch {
    worker = null;
  }
  return worker;
}

export async function extractPeaksOffThread(
  pcm: Float32Array,
  sampleRate: number,
  binsPerSec: number,
  startSec: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const w = getWorker();
  if (!w) {
    const r = await extractPeaksIdle(
      pcm,
      sampleRate,
      binsPerSec,
      startSec,
      signal,
    );
    return r.peaks;
  }
  const id = `w${seq++}`;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      pending.delete(id);
      w.postMessage({ type: "abort", id } satisfies WorkerAbortMsg);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, {
      resolve: (peaks) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(peaks);
      },
      reject: (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    });
    const copy = new Float32Array(pcm);
    w.postMessage(
      {
        type: "extract",
        id,
        pcm: copy,
        sampleRate,
        binsPerSec,
        startSec,
      } satisfies WorkerExtractMsg,
      [copy.buffer],
    );
  });
}

export function handleWorkerMessage(
  msg: WorkerExtractMsg | WorkerAbortMsg,
  aborted: Set<string>,
): WorkerResultMsg | WorkerErrorMsg | null {
  if (msg.type === "abort") {
    aborted.add(msg.id);
    return null;
  }
  if (aborted.has(msg.id)) {
    aborted.delete(msg.id);
    return null;
  }
  try {
    const r = extractPeaksFromPcm(
      msg.pcm,
      msg.sampleRate,
      msg.binsPerSec,
      msg.startSec,
    );
    return {
      type: "result",
      id: msg.id,
      peaks: r.peaks,
      binsPerSec: r.binsPerSec,
      startSec: r.startSec,
      endSec: r.endSec,
    };
  } catch (err) {
    return {
      type: "error",
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
