import { e2eRoomTonePcm } from "../monitor/e2eHook";
import { ROOM_TONE_DURATION_SEC } from "../types";
import keeperProcessorSource from "./keeperProcessor.js?raw";
import keeperProcessorUrl from "./keeperProcessor.js?url";
import { KEEPER_SAMPLE_RATE } from "./pcm";

export const KEEPER_PROCESSOR_NAME = "sharecut-keeper";

export const KEEPER_PROCESSOR_SOURCE = keeperProcessorSource;

export async function attachKeeperTap(
  stream: MediaStream,
  onPcm: (pcm: Float32Array, sampleRate: number) => void,
): Promise<() => void> {
  const testPcm = e2eRoomTonePcm(KEEPER_SAMPLE_RATE, ROOM_TONE_DURATION_SEC);
  if (testPcm) {
    queueMicrotask(() => onPcm(testPcm, KEEPER_SAMPLE_RATE));
    return () => undefined;
  }
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext({ sampleRate: KEEPER_SAMPLE_RATE });
    try {
      await ctx.resume();
    } catch {
      // Autoplay may block resume until a later gesture; process() still runs
      // once the context is running.
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
      // Second chance after the worklet graph is connected.
    }
    const opened = ctx;
    return () => {
      source.disconnect();
      node.port.onmessage = null;
      node.disconnect();
      silent.disconnect();
      void opened.close();
    };
  } catch (err) {
    if (ctx) {
      void ctx.close();
    }
    throw err;
  }
}
