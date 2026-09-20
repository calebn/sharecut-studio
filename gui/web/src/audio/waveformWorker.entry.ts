import {
  handleWorkerMessage,
  type WorkerAbortMsg,
  type WorkerExtractMsg,
} from "./waveformWorker";

const aborted = new Set<string>();

self.onmessage = (ev: MessageEvent<WorkerExtractMsg | WorkerAbortMsg>) => {
  const out = handleWorkerMessage(ev.data, aborted);
  if (out) {
    const transfer = out.type === "result" ? [out.peaks.buffer] : [];
    (self as unknown as Worker).postMessage(out, transfer);
  }
};
