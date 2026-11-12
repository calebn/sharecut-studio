import type { Page } from "@playwright/test";

/** What the page recorded about the OS media surface, read back by the specs. */
export interface OsRecorderSnapshot {
  metadata: { title: string; artist: string; album: string } | null;
  playbackState: string;
  handlers: Record<string, "fn" | null>;
  positionStates: Array<{
    duration: number;
    playbackRate: number;
    position: number;
  } | null>;
  violations: string[];
  media: Array<{
    src: string;
    paused: boolean;
    duration: number;
    readyState: number;
    loop: boolean;
    muted: boolean;
    error: number | null;
  }>;
  contexts: string[];
}

interface RecorderWindow extends Window {
  __os: {
    handlers: Record<string, MediaSessionActionHandler | null>;
    positionStates: OsRecorderSnapshot["positionStates"];
    violations: string[];
    media: HTMLMediaElement[];
    contexts: AudioContext[];
  };
}

/** Runs in the page before any app script: wraps the Media Session, tracks every media element and AudioContext. */
function record(): void {
  const rec: RecorderWindow["__os"] = {
    handlers: {},
    positionStates: [],
    violations: [],
    media: [],
    contexts: [],
  };
  (window as unknown as RecorderWindow).__os = rec;

  const session = navigator.mediaSession;
  const setHandler = session.setActionHandler.bind(session);
  session.setActionHandler = (action, handler) => {
    rec.handlers[action] = handler;
    return setHandler(action, handler);
  };
  const setPosition = session.setPositionState.bind(session);
  session.setPositionState = (state) => {
    rec.positionStates.push(
      state
        ? {
            duration: state.duration ?? Number.NaN,
            playbackRate: state.playbackRate ?? 1,
            position: state.position ?? 0,
          }
        : null,
    );
    return setPosition(state);
  };

  const track = (element: HTMLMediaElement) => {
    if (!rec.media.includes(element)) rec.media.push(element);
  };
  const NativeAudio = window.Audio;
  window.Audio = function Audio(src?: string) {
    const element = new NativeAudio(src);
    track(element);
    return element;
  } as unknown as typeof Audio;
  window.Audio.prototype = NativeAudio.prototype;
  const createElement = document.createElement.bind(document);
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const element = createElement(tag, options);
    if (/^(audio|video)$/i.test(tag)) track(element as HTMLMediaElement);
    return element;
  }) as typeof document.createElement;
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    track(this);
    return play.call(this);
  };

  for (const name of ["AudioContext", "webkitAudioContext"] as const) {
    const Native = (window as unknown as Record<string, typeof AudioContext>)[
      name
    ];
    if (!Native) continue;
    (window as unknown as Record<string, typeof AudioContext>)[name] =
      class extends Native {
        constructor(options?: AudioContextOptions) {
          super(options);
          rec.contexts.push(this);
        }
      };
  }

  document.addEventListener("securitypolicyviolation", (event) => {
    rec.violations.push(`${event.effectiveDirective} ${event.blockedURI}`);
  });
}

export async function installOsRecorder(page: Page): Promise<void> {
  await page.addInitScript(record);
}

export function readOsRecorder(page: Page): Promise<OsRecorderSnapshot> {
  return page.evaluate(() => {
    const rec = (window as unknown as RecorderWindow).__os;
    const metadata = navigator.mediaSession.metadata;
    return {
      metadata: metadata
        ? {
            title: metadata.title,
            artist: metadata.artist,
            album: metadata.album,
          }
        : null,
      playbackState: navigator.mediaSession.playbackState,
      handlers: Object.fromEntries(
        Object.entries(rec.handlers).map(([action, handler]) => [
          action,
          handler ? ("fn" as const) : null,
        ]),
      ),
      positionStates: [...rec.positionStates],
      violations: [...rec.violations],
      media: rec.media.map((element) => ({
        src: element.src.startsWith("data:") ? "data:" : element.src,
        paused: element.paused,
        duration: element.duration,
        readyState: element.readyState,
        loop: element.loop,
        muted: element.muted,
        error: element.error ? element.error.code : null,
      })),
      contexts: rec.contexts.map((context) => context.state),
    };
  });
}

/** Calls the handler the page registered, the way the lock screen does. */
export function fireOsAction(
  page: Page,
  action: string,
  details: Partial<MediaSessionActionDetails> = {},
): Promise<void> {
  return page.evaluate(
    ([name, extra]) => {
      const handler = (window as unknown as RecorderWindow).__os.handlers[
        name as string
      ];
      if (!handler) throw new Error(`no ${name} handler registered`);
      return handler({
        action: name as MediaSessionAction,
        ...(extra as object),
      });
    },
    [action, details] as const,
  );
}

/** Pauses or plays the first media element with a blob source, as the OS does to the keep-alive. */
export function driveKeepAlive(
  page: Page,
  verb: "pause" | "play",
): Promise<void> {
  return page.evaluate(async (what) => {
    const element = (window as unknown as RecorderWindow).__os.media.find(
      (media) => media.src.startsWith("blob:"),
    );
    if (!element) throw new Error("no blob keep-alive element");
    if (what === "pause") element.pause();
    else await element.play();
  }, verb);
}

/** Suspends the first AudioContext from the page, the way an OS interruption does. */
export function suspendContext(page: Page): Promise<void> {
  return page.evaluate(async () => {
    const context = (window as unknown as RecorderWindow).__os.contexts[0];
    if (!context) throw new Error("no AudioContext");
    await context.suspend();
  });
}
