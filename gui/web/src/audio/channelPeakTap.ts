/** Separate channel taps prevent opposite-polarity stereo peaks cancelling. */
export function createChannelPeakTap(
  ctx: Pick<
    AudioContext,
    "createGain" | "createAnalyser" | "createChannelSplitter" | "destination"
  >,
  input: Pick<AudioNode, "connect" | "disconnect">,
) {
  const cleanup: (() => void)[] = [];
  try {
    const splitter = ctx.createChannelSplitter(2);
    cleanup.push(() => splitter.disconnect());
    const sink = ctx.createGain();
    cleanup.push(() => sink.disconnect());
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    const channels = [0, 1].map((channel) => {
      const analyser = ctx.createAnalyser();
      cleanup.push(() => analyser.disconnect());
      analyser.fftSize = 2048;
      splitter.connect(analyser, channel);
      analyser.connect(sink);
      return { analyser, samples: new Float32Array(analyser.fftSize) };
    });
    input.connect(splitter);
    cleanup.push(() => input.disconnect(splitter));
    const samples = new Float32Array(4096);
    return {
      read(): Float32Array {
        for (const [index, channel] of channels.entries()) {
          channel.analyser.getFloatTimeDomainData(channel.samples);
          samples.set(channel.samples, index * 2048);
        }
        return samples;
      },
      dispose(): void {
        for (const disconnect of cleanup.reverse()) disconnect();
      },
    };
  } catch (error) {
    for (const disconnect of cleanup.reverse()) disconnect();
    throw error;
  }
}
