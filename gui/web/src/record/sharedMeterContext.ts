import { audioContextCtor } from "../utils/audio";
import inputMeterProcessorUrl from "./inputMeterProcessor.js?url";

type SharedContext = {
  ctx: AudioContext;
  ready: Promise<void>;
  users: number;
};

let shared: SharedContext | null = null;

/** Meter-only context; keeper capture retains its own fixed-rate graph. */
export function acquireMeterContext(): {
  ctx: AudioContext;
  ready: Promise<void>;
  release: () => void;
} | null {
  if (!shared) {
    const AC = audioContextCtor();
    if (!AC) return null;
    const ctx = new AC();
    let ready: Promise<void>;
    try {
      ready = ctx.audioWorklet.addModule(inputMeterProcessorUrl);
    } catch (error) {
      void ctx.close().catch(() => undefined);
      throw error;
    }
    shared = { ctx, ready, users: 0 };
  }
  const entry = shared;
  entry.users += 1;
  let released = false;
  return {
    ctx: entry.ctx,
    ready: entry.ready,
    release: () => {
      if (released) return;
      released = true;
      entry.users -= 1;
      if (entry.users === 0) {
        if (shared === entry) shared = null;
        void entry.ctx.close().catch(() => undefined);
      }
    },
  };
}
