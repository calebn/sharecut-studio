class SharecutInputMeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.clipThreshold =
      options.processorOptions?.clipThreshold ?? 10 ** (-1 / 20);
    this.epoch = 0;
    this.clipped = false;
    this.peak = 0;
    this.blocks = 0;
    this.lastHotFrame = Number.NEGATIVE_INFINITY;
    this.port.onmessage = (event) => {
      if (event.data?.type === "clear") {
        // Audio processed after the UI's audio-clock cutoff may precede this
        // command. Keep the latest hot frame across clears for that race.
        this.clipped = this.lastHotFrame >= event.data.clearFrame;
        this.port.postMessage({
          type: "clearAck",
          epoch: event.data.epoch,
          clipped: this.clipped,
        });
        this.epoch = event.data.epoch;
        this.peak = 0;
        this.blocks = 0;
      }
    };
  }

  process(inputs) {
    let peak = 0;
    for (const channel of inputs[0] ?? []) {
      for (let i = 0; i < channel.length; i++) {
        const sample = Math.abs(channel[i]);
        peak = Math.max(peak, sample);
        if (sample >= this.clipThreshold) {
          this.lastHotFrame = Math.max(this.lastHotFrame, currentFrame + i);
        }
      }
    }
    const firstClip = !this.clipped && peak >= this.clipThreshold;
    if (firstClip) this.clipped = true;
    this.peak = Math.max(this.peak, peak);
    this.blocks += 1;
    // Batch routine readings; notify immediately when overload first occurs.
    if (firstClip || this.blocks >= 8) {
      this.port.postMessage({
        peak: this.peak,
        clipped: this.clipped,
        epoch: this.epoch,
      });
      this.peak = 0;
      this.blocks = 0;
    }
    return true;
  }
}

registerProcessor("sharecut-input-meter", SharecutInputMeterProcessor);
