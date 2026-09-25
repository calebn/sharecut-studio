export const SILENT_PCM_ALARM_MS = 5_000;
export const SILENT_PCM_TICK_MS = 1_000;
export const PCM_SILENCE_FLOOR = 2 ** -24;

export function pcmHasSignal(pcm: Float32Array): boolean {
  for (let i = 0; i < pcm.length; i += 1) {
    if (Math.abs(pcm[i] ?? 0) > PCM_SILENCE_FLOOR) return true;
  }
  return false;
}

/** Detects sustained all-zero or missing PCM while local capture is active. */
export class SilentPcmWatchdog {
  private armed: boolean;
  private alarmed: boolean;
  private lastSignalAt: number;
  private lastTickAt: number;
  readonly alarmMs: number;
  readonly tickMs: number;

  constructor(alarmMs = SILENT_PCM_ALARM_MS, tickMs = SILENT_PCM_TICK_MS) {
    this.armed = false;
    this.alarmed = false;
    this.lastSignalAt = 0;
    this.lastTickAt = 0;
    this.alarmMs = alarmMs;
    this.tickMs = tickMs;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  get isAlarmed(): boolean {
    return this.alarmed;
  }

  arm(now: number): void {
    this.armed = true;
    this.alarmed = false;
    this.lastSignalAt = now;
    this.lastTickAt = now;
  }

  disarm(): void {
    this.armed = false;
    this.alarmed = false;
  }

  /** Returns true when real signal cleared an active alarm. */
  observe(pcm: Float32Array, now: number): boolean {
    if (!this.armed || !pcmHasSignal(pcm)) return false;
    this.lastSignalAt = now;
    const cleared = this.alarmed;
    this.alarmed = false;
    return cleared;
  }

  /**
   * Returns true on the transition into the alarmed state. A late tick
   * (throttled or background tab, sleep) restarts the silence window rather
   * than counting the gap as silence.
   */
  tick(now: number): boolean {
    if (!this.armed) return false;
    const late = now - this.lastTickAt > this.tickMs * 2;
    this.lastTickAt = now;
    if (late) {
      this.lastSignalAt = now;
      return false;
    }
    if (this.alarmed || now - this.lastSignalAt < this.alarmMs) {
      return false;
    }
    this.alarmed = true;
    return true;
  }
}
