import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enterPlaybackSession,
  KEEP_ALIVE_SEC,
  leavePlaybackSession,
  releasePlaybackSession,
  resetPlaybackSessionForTest,
  silentWavBytes,
} from "./playbackSession";

class FakeElement extends EventTarget {
  loop = false;
  src = "";
  paused = true;
  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  /** The OS acting on the element: it changes state, then the event follows. */
  osPause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  osPlay() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }
}

const url = () => "blob:keep-alive";
const events = () => ({ onSystemPause: vi.fn(), onSystemPlay: vi.fn() });

afterEach(() => resetPlaybackSessionForTest());

describe("playback session (#1764, #3785)", () => {
  it("asks for a playback audio session and loops a blob element", () => {
    const nav = { audioSession: { type: "auto" } };
    const el = new FakeElement();
    enterPlaybackSession(events(), nav, () => el, url);
    expect(nav.audioSession.type).toBe("playback");
    expect(el.loop).toBe(true);
    expect(el.src).toBe("blob:keep-alive");
    expect(el.play).toHaveBeenCalledTimes(1);
  });

  it("reuses one element across plays and pauses it on leave", () => {
    const el = new FakeElement();
    const create = vi.fn(() => el);
    enterPlaybackSession(events(), {}, create, url);
    enterPlaybackSession(events(), {}, create, url);
    expect(create).toHaveBeenCalledTimes(1);
    expect(el.play).toHaveBeenCalledTimes(2);
    leavePlaybackSession();
    expect(el.pause).toHaveBeenCalledTimes(1);
  });

  it("never throws when the audio session or the element is unavailable", () => {
    const nav = {};
    Object.defineProperty(nav, "audioSession", {
      get: () => ({
        set type(_v: string) {
          throw new Error("locked");
        },
      }),
    });
    expect(() => enterPlaybackSession(events(), nav, () => null)).not.toThrow();
    const rejecting = new FakeElement();
    rejecting.play = vi.fn(() => Promise.reject(new Error("autoplay")));
    resetPlaybackSessionForTest();
    expect(() =>
      enterPlaybackSession(events(), {}, () => rejecting, url),
    ).not.toThrow();
  });

  it("reports an OS pause of the entered element once", () => {
    const el = new FakeElement();
    const e = events();
    enterPlaybackSession(e, {}, () => el, url);
    el.osPause();
    el.osPause();
    expect(e.onSystemPause).toHaveBeenCalledTimes(1);
  });

  it("does not report its own pause on leave", () => {
    const el = new FakeElement();
    const e = events();
    enterPlaybackSession(e, {}, () => el, url);
    leavePlaybackSession();
    el.dispatchEvent(new Event("pause"));
    expect(e.onSystemPause).not.toHaveBeenCalled();
  });

  it("ignores a stale pause event after a quick re-enter", () => {
    const el = new FakeElement();
    const e = events();
    enterPlaybackSession(e, {}, () => el, url);
    leavePlaybackSession();
    enterPlaybackSession(e, {}, () => el, url);
    el.dispatchEvent(new Event("pause"));
    expect(e.onSystemPause).not.toHaveBeenCalled();
  });

  it("reports an OS play only after the app left", () => {
    const el = new FakeElement();
    const e = events();
    enterPlaybackSession(e, {}, () => el, url);
    el.dispatchEvent(new Event("play"));
    expect(e.onSystemPlay).not.toHaveBeenCalled();
    el.osPause();
    el.osPlay();
    expect(e.onSystemPlay).toHaveBeenCalledTimes(1);
  });

  it("leaves the session not entered when the element refuses to play", async () => {
    const el = new FakeElement();
    const e = events();
    enterPlaybackSession(e, {}, () => el, url);
    leavePlaybackSession();
    el.play.mockImplementationOnce(() => Promise.reject(new Error("blocked")));
    enterPlaybackSession(e, {}, () => el, url);
    await Promise.resolve();
    await Promise.resolve();
    el.dispatchEvent(new Event("pause"));
    expect(e.onSystemPause).not.toHaveBeenCalled();
  });

  it("does not report to the events of a disposed engine", () => {
    const el = new FakeElement();
    const e = events();
    enterPlaybackSession(e, {}, () => el, url);
    leavePlaybackSession();
    releasePlaybackSession(e);
    el.osPlay();
    expect(e.onSystemPlay).not.toHaveBeenCalled();
  });

  it("keeps the events of a newer engine when an older one is released", () => {
    const el = new FakeElement();
    const older = events();
    const newer = events();
    enterPlaybackSession(older, {}, () => el, url);
    leavePlaybackSession();
    enterPlaybackSession(newer, {}, () => el, url);
    leavePlaybackSession();
    releasePlaybackSession(older);
    el.osPlay();
    expect(newer.onSystemPlay).toHaveBeenCalledTimes(1);
  });

  it("pauses the element when the OS plays it with no engine registered", () => {
    const el = new FakeElement();
    const e = events();
    enterPlaybackSession(e, {}, () => el, url);
    leavePlaybackSession();
    releasePlaybackSession(e);
    el.pause.mockClear();
    el.osPlay();
    expect(el.pause).toHaveBeenCalledTimes(1);
    expect(el.paused).toBe(true);
  });

  it("still resumes from the OS after an ordinary pause", () => {
    const el = new FakeElement();
    const e = events();
    enterPlaybackSession(e, {}, () => el, url);
    leavePlaybackSession();
    el.osPlay();
    expect(e.onSystemPlay).toHaveBeenCalledTimes(1);
  });

  it("builds a silent WAV longer than 5 s", () => {
    const bytes = silentWavBytes(KEEP_ALIVE_SEC);
    const view = new DataView(bytes.buffer);
    const text = (at: number) =>
      String.fromCharCode(...bytes.slice(at, at + 4));
    expect(text(0)).toBe("RIFF");
    expect(text(8)).toBe("WAVE");
    const seconds = view.getUint32(40, true) / view.getUint32(28, true);
    expect(seconds).toBe(6);
    expect(bytes.length).toBe(44 + 6 * 8000 * 2);
    expect(bytes.slice(44).every((b) => b === 0)).toBe(true);
  });
});
