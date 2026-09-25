import { peakLinear } from "../../audio/metering";

export const SILENT_PCM_ALARM_MS = 5_000;
export const SILENT_PCM_TICK_MS = 1_000;
export const PCM_SILENCE_FLOOR = 2 ** -24;

/** Any sample above the floor is signal; a constant DC offset or dither on a dead input is not detected. */
export function pcmHasSignal(pcm: Float32Array): boolean {
  return peakLinear(pcm) > PCM_SILENCE_FLOOR;
}

/** Detects sustained all-zero or missing PCM while local capture is active. */
export class SilentPcmWatchdog {
  private armed: boolean;
  private alarmed: boolean;
  private lastSignalAt: number;
  private lastTickAt: number;
  private rechecked: boolean;
  readonly alarmMs: number;
  readonly tickMs: number;

  constructor(alarmMs = SILENT_PCM_ALARM_MS, tickMs = SILENT_PCM_TICK_MS) {
    this.armed = false;
    this.alarmed = false;
    this.lastSignalAt = 0;
    this.lastTickAt = 0;
    this.rechecked = false;
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
    this.rechecked = false;
  }

  disarm(): void {
    this.armed = false;
    this.alarmed = false;
    this.rechecked = false;
  }

  /** Restarts the window after a healthy Check mic; a re-alarm then means the check did not help. */
  recheck(now: number): void {
    this.arm(now);
    this.rechecked = true;
  }

  /** True when the current silence started at a healthy Check mic with no real PCM since. */
  get silentSinceCheck(): boolean {
    return this.rechecked;
  }

  /** Returns true when real signal cleared an active alarm. */
  observe(pcm: Float32Array, now: number): boolean {
    if (!this.armed || !pcmHasSignal(pcm)) return false;
    this.lastSignalAt = now;
    this.rechecked = false;
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
