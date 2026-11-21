/**
 * iPhone Safari mutes Web Audio output while the ring/silent switch is on, but keeps
 * playing media (an HTML audio element in a "playback" audio session) like a podcast app.
 * The guest proxy transport plays through Web Audio, so it asks for a playback session and
 * keeps a silent looping audio element alive while it plays (#1764).
 *
 * That element is also what the OS adopts as the thing playing (#3785). WebKit lets a
 * Web Audio context be Now Playing only as a source it cannot seek, which drops the skip
 * buttons and bypasses the page's Media Session handlers; Chromium builds a media session
 * only from elements. So the element must load (the page CSP allows `blob:`, not `data:`),
 * last more than 5 s (Chromium's persistent-media threshold) and stay unmuted (WebKit
 * excludes muted elements). It is created, and given its source, only on the first Play,
 * so opening a link never takes over the listener's lock screen.
 */

type AudioSessionLike = { type?: string };
type NavigatorWithSession = { audioSession?: AudioSessionLike };
type KeepAliveElement = {
  loop: boolean;
  src: string;
  paused: boolean;
  play: () => Promise<void> | void;
  pause: () => void;
  load: () => void;
  removeAttribute: (name: "src") => void;
  addEventListener: (type: "pause" | "play", listener: () => void) => void;
  removeEventListener: (type: "pause" | "play", listener: () => void) => void;
};

type KeepAliveResource = {
  element: KeepAliveElement;
  url: string;
  onPause: () => void;
  onPlay: () => void;
};

/** The OS paused or resumed the element behind the app's back (a call, Siri, a lock-screen button). */
export type PlaybackSessionEvents = Readonly<{
  onSystemPause: () => void;
  onSystemPlay: () => void;
}>;

const SILENT_SAMPLE_RATE = 8000;
/** Over Chromium's 5 s persistent-media threshold and WebKit's 0.95 s. */
export const KEEP_ALIVE_SEC = 6;

export function silentWavBytes(seconds: number): Uint8Array {
  const dataBytes = Math.round(seconds * SILENT_SAMPLE_RATE) * 2;
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
  return bytes;
}

let keepAlive: KeepAliveResource | null = null;
let events: PlaybackSessionEvents | null = null;
/** The live enter call, null once left or refused; the element's own events count only while set. */
let entry: object | null = null;

function defaultCreateElement(): KeepAliveElement | null {
  return typeof Audio === "undefined" ? null : new Audio();
}

function defaultCreateObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

function disposeKeepAlive({
  element,
  url,
  onPause,
  onPlay,
}: KeepAliveResource): void {
  const steps = [
    () => element.removeEventListener("pause", onPause),
    () => element.removeEventListener("play", onPlay),
    () => {
      if (!element.paused) element.pause();
    },
    () => element.removeAttribute("src"),
    () => element.load(),
    () => URL.revokeObjectURL(url),
  ];
  for (const step of steps) {
    try {
      step();
    } catch {}
  }
}

function createKeepAlive(
  element: KeepAliveElement,
  createObjectUrl: (blob: Blob) => string,
): KeepAliveResource {
  element.loop = true;
  const resource = {
    element,
    url: createObjectUrl(
      new Blob([silentWavBytes(KEEP_ALIVE_SEC) as BlobPart], {
        type: "audio/wav",
      }),
    ),
    onPause: () => {
      if (keepAlive !== resource || !entry || !element.paused) return;
      entry = null;
      events?.onSystemPause();
    },
    onPlay: () => {
      if (keepAlive !== resource || entry || element.paused) return;
      events?.onSystemPlay();
    },
  };
  try {
    element.src = resource.url;
    element.addEventListener("pause", resource.onPause);
    element.addEventListener("play", resource.onPlay);
    return resource;
  } catch (error) {
    disposeKeepAlive(resource);
    throw error;
  }
}

/**
 * Call inside the play action. Asks for a playback audio session where the browser has
 * one (Safari 16.4+) and starts a silent looping element so the OS treats the page as media.
 */
export function enterPlaybackSession(
  sessionEvents: PlaybackSessionEvents,
  nav: NavigatorWithSession | undefined = typeof navigator === "undefined"
    ? undefined
    : (navigator as unknown as NavigatorWithSession),
  createElement: () => KeepAliveElement | null = defaultCreateElement,
  createObjectUrl: (blob: Blob) => string = defaultCreateObjectUrl,
): void {
  try {
    if (nav?.audioSession) {
      nav.audioSession.type = "playback";
    }
  } catch {
    // An unsupported or locked session type must never stop playback.
  }
  events = sessionEvents;
  const mine = {};
  entry = mine;
  try {
    if (!keepAlive) {
      const element = createElement();
      if (element) keepAlive = createKeepAlive(element, createObjectUrl);
    }
    const started = keepAlive?.element.play();
    if (started && typeof (started as Promise<void>).catch === "function") {
      (started as Promise<void>).catch(() => {
        if (entry === mine) entry = null;
      });
    }
  } catch {
    // Autoplay rules can refuse the silent element; the Web Audio path still runs.
    if (entry === mine) entry = null;
  }
}

/** Pause the silent element when playback pauses; the paused element keeps the lock screen's place. */
export function leavePlaybackSession(owner?: PlaybackSessionEvents): void {
  if (owner && events !== owner) return;
  entry = null;
  try {
    keepAlive?.element.pause();
  } catch {
    // ignore
  }
}

export function releasePlaybackSession(
  sessionEvents: PlaybackSessionEvents,
): void {
  if (events !== sessionEvents) return;
  const resource = keepAlive;
  keepAlive = null;
  events = null;
  entry = null;
  if (resource) disposeKeepAlive(resource);
}

export function resetPlaybackSessionForTest(): void {
  if (events) releasePlaybackSession(events);
}
