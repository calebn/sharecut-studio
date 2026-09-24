class SharecutInputMeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.clipThreshold =
      options.processorOptions?.clipThreshold ?? 10 ** (-1 / 20);
    this.epoch = 0;
    this.clipped = false;
    this.peak = 0;
    this.blocks = 0;
    this.hotBlocks = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "clear") {
        // A hot block can run after the UI clears but before this message
        // arrives. Report its sequence before resetting the sticky latch.
        this.port.postMessage({
          type: "clearAck",
          epoch: event.data.epoch,
          hotBlocks: this.hotBlocks,
        });
        this.epoch = event.data.epoch;
        this.clipped = false;
        this.peak = 0;
        this.blocks = 0;
      }
    };
  }

  process(inputs) {
    let peak = 0;
    for (const channel of inputs[0] ?? []) {
      for (let i = 0; i < channel.length; i++) {
        peak = Math.max(peak, Math.abs(channel[i]));
      }
    }
    const firstClip = !this.clipped && peak >= this.clipThreshold;
    if (peak >= this.clipThreshold) this.hotBlocks += 1;
    if (firstClip) this.clipped = true;
    this.peak = Math.max(this.peak, peak);
    this.blocks += 1;
    // Batch routine readings; notify immediately when overload first occurs.
    if (firstClip || this.blocks >= 8) {
      this.port.postMessage({
        peak: this.peak,
        clipped: this.clipped,
        epoch: this.epoch,
        hotBlocks: this.hotBlocks,
      });
      this.peak = 0;
      this.blocks = 0;
    }
    return true;
  }
}

registerProcessor("sharecut-input-meter", SharecutInputMeterProcessor);
