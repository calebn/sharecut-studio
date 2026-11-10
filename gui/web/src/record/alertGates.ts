const WINDOW_MS = 30_000;
const COUNT = 3;

export function clippingGate(regions: readonly { startMs: number }[]): boolean {
  const starts = regions.map((r) => r.startMs).sort((a, b) => a - b);
  for (let i = 0; i + COUNT <= starts.length; i++) {
    if (starts[i + COUNT - 1] - starts[i] <= WINDOW_MS) return true;
  }
  return false;
}

/** Block RMS (dBFS) at which speech starts while muted. */
const MUTED_SPEECH_ENTER_DB = -45;
/** Block RMS (dBFS) below which speech stops; the gap to enter bridges word tails. */
const MUTED_SPEECH_EXIT_DB = -50;
/** Quiet after the last speech sample that still counts as speech. */
const MUTED_SPEECH_HANGOVER_MS = 400;
/** Accumulated speech while muted before the alert shows. */
const MUTED_SPEECH_NEEDED_MS = 10_000;
/** Quiet that drops the count and clears the alert. */
const MUTED_SPEECH_QUIET_RESET_MS = 4_000;
/** A longer gap between ticks (throttled tab) is clock only, never credited. */
const MUTED_SPEECH_MAX_GAP_MS = 500;

export type MutedSpeechState = {
  speechMs: number;
  lastTickMs: number | null;
  lastSpeechMs: number | null;
  speaking: boolean;
  fired: boolean;
};

type MutedSpeechTick = {
  nowMs: number;
  /** Block RMS in dBFS; null when nothing could be read. */
  levelDb: number | null;
  /** The take is recording; false (paused) freezes the gate. */
  counting: boolean;
};

export const MUTED_SPEECH_INITIAL: MutedSpeechState = {
  speechMs: 0,
  lastTickMs: null,
  lastSpeechMs: null,
  speaking: false,
  fired: false,
};

/**
 * Whether to show "You're muted.": 10 s of accumulated speech while muted.
 * Pure; the caller supplies the clock. A pause freezes it, and 4 s of quiet clears it.
 */
export function mutedSpeechGate(
  state: MutedSpeechState,
  { nowMs, levelDb, counting }: MutedSpeechTick,
): MutedSpeechState {
  const gap = state.lastTickMs === null ? 0 : nowMs - state.lastTickMs;
  if (!counting || gap > MUTED_SPEECH_MAX_GAP_MS) {
    return {
      ...state,
      lastTickMs: nowMs,
      lastSpeechMs:
        state.lastSpeechMs === null ? null : state.lastSpeechMs + gap,
    };
  }
  const speaking =
    levelDb !== null &&
    levelDb >= (state.speaking ? MUTED_SPEECH_EXIT_DB : MUTED_SPEECH_ENTER_DB);
  const lastSpeechMs = speaking ? nowMs : state.lastSpeechMs;
  const quietMs = lastSpeechMs === null ? 0 : nowMs - lastSpeechMs;
  if (quietMs >= MUTED_SPEECH_QUIET_RESET_MS) {
    return { ...MUTED_SPEECH_INITIAL, lastTickMs: nowMs };
  }
  const heard =
    speaking || (lastSpeechMs !== null && quietMs <= MUTED_SPEECH_HANGOVER_MS);
  const speechMs = state.speechMs + (heard ? gap : 0);
  return {
    speechMs,
    lastTickMs: nowMs,
    lastSpeechMs,
    speaking,
    fired: state.fired || speechMs >= MUTED_SPEECH_NEEDED_MS,
  };
}
