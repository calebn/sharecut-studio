import keeperProcessorSource from "./keeperProcessor.js?raw";
import keeperProcessorUrl from "./keeperProcessor.js?url";
import { KEEPER_SAMPLE_RATE } from "./pcm";

export const KEEPER_PROCESSOR_NAME = "sharecut-keeper";

export const KEEPER_PROCESSOR_SOURCE = keeperProcessorSource;

export type KeeperTap = {
  stop: () => void;
  resume: () => Promise<AudioContextState>;
};

export async function openKeeperTap(
  stream: MediaStream,
  onPcm: (pcm: Float32Array, sampleRate: number) => void,
): Promise<KeeperTap> {
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext({ sampleRate: KEEPER_SAMPLE_RATE });
    try {
      await ctx.resume();
    } catch {
      // Autoplay may block resume until a later gesture. A suspended context
      // yields no PCM, which the silent-PCM watchdog reports; Check mic retries.
    }
    await ctx.audioWorklet.addModule(keeperProcessorUrl);
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, KEEPER_PROCESSOR_NAME);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      onPcm(ev.data, ctx?.sampleRate ?? KEEPER_SAMPLE_RATE);
    };
    source.connect(node);
    node.connect(silent);
    source.connect(silent);
    silent.connect(ctx.destination);
    try {
      await ctx.resume();
    } catch {
      // Second chance; a still-suspended context is reported by the watchdog.
    }
    const opened = ctx;
    return {
      stop: () => {
        source.disconnect();
        node.port.onmessage = null;
        node.disconnect();
        silent.disconnect();
        void opened.close().catch(() => undefined);
      },
      resume: async () => {
        try {
          await opened.resume();
        } catch {
          // The returned state reports a context that stayed suspended.
        }
        return opened.state;
      },
    };
  } catch (err) {
    if (ctx) {
      void ctx.close().catch(() => undefined);
    }
    throw err;
  }
}
