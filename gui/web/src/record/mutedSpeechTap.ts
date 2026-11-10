export type MutedSpeechTap = {
  /** Block RMS in dBFS, or null once disposed. */
  readDb: () => number | null;
  dispose: () => void;
};

type TapContext = Pick<
  AudioContext,
  "createMediaStreamSource" | "createAnalyser" | "createGain" | "destination"
>;

const WINDOW = 1024;
const FLOOR_DB = -120;

/**
 * Listen to a clone of the mic while it is muted. The clone keeps flowing when
 * the sent track is disabled and feeds only a local analyser; nothing from it
 * is sent, recorded or stored. Returns null when the clone cannot be tapped.
 */
export function createMutedSpeechTap(
  ctx: TapContext,
  stream: MediaStream,
): MutedSpeechTap | null {
  let copy: MediaStream | null = null;
  try {
    copy = stream.clone();
    for (const track of copy.getAudioTracks()) track.enabled = true;
    const source = ctx.createMediaStreamSource(copy);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = WINDOW;
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(analyser);
    analyser.connect(silent);
    silent.connect(ctx.destination);
    const samples = new Float32Array(WINDOW);
    let disposed = false;
    return {
      readDb: () => {
        if (disposed) return null;
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const rms = Math.sqrt(sum / samples.length);
        return rms > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(rms)) : FLOOR_DB;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        source.disconnect();
        analyser.disconnect();
        silent.disconnect();
        for (const track of copy?.getTracks() ?? []) track.stop();
      },
    };
  } catch {
    for (const track of copy?.getTracks() ?? []) track.stop();
    return null;
  }
}
