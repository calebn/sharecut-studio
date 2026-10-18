/**
 * iPhone Safari mutes Web Audio output while the ring/silent switch is on, but keeps
 * playing media (an HTML audio element in a "playback" audio session) like a podcast app.
 * The guest proxy transport plays through Web Audio, so it asks for a playback session and
 * keeps a silent looping audio element alive while it plays (#1764).
 */

type AudioSessionLike = { type?: string };
type NavigatorWithSession = { audioSession?: AudioSessionLike };
type KeepAliveElement = {
  loop: boolean;
  src: string;
  play: () => Promise<void> | void;
  pause: () => void;
};

const SILENT_SAMPLE_RATE = 8000;
const SILENT_SAMPLES = 800;

/** A 0.1 s silent mono 16-bit WAV as a data URI (small, no network). */
export function silentWavDataUri(): string {
  const dataBytes = SILENT_SAMPLES * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      bytes[offset + i] = text.charCodeAt(i);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SILENT_SAMPLE_RATE, true);
  view.setUint32(28, SILENT_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

let keepAlive: KeepAliveElement | null = null;

function defaultCreateElement(): KeepAliveElement | null {
  return typeof Audio === "undefined" ? null : new Audio();
}

/**
 * Call inside the play action. Asks for a playback audio session where the browser has
 * one (Safari 16.4+) and starts a silent looping element so iOS treats the page as media.
 */
export function enterPlaybackSession(
  nav: NavigatorWithSession | undefined = typeof navigator === "undefined"
    ? undefined
    : (navigator as unknown as NavigatorWithSession),
  createElement: () => KeepAliveElement | null = defaultCreateElement,
): void {
  try {
    if (nav?.audioSession) {
      nav.audioSession.type = "playback";
    }
  } catch {
    // An unsupported or locked session type must never stop playback.
  }
  try {
    if (!keepAlive) {
      keepAlive = createElement();
      if (keepAlive) {
        keepAlive.loop = true;
        keepAlive.src = silentWavDataUri();
      }
    }
    const started = keepAlive?.play();
    if (started && typeof (started as Promise<void>).catch === "function") {
      (started as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Autoplay rules can refuse the silent element; the Web Audio path still runs.
  }
}

/** Stop the silent element when playback pauses so the lock screen does not show media. */
export function leavePlaybackSession(): void {
  try {
    keepAlive?.pause();
  } catch {
    // ignore
  }
}

/** Test seam: forget the shared element. */
export function resetPlaybackSessionForTest(): void {
  keepAlive = null;
}
