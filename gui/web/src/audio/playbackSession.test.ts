import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enterPlaybackSession,
  leavePlaybackSession,
  resetPlaybackSessionForTest,
  silentWavDataUri,
} from "./playbackSession";

function fakeElement() {
  return {
    loop: false,
    src: "",
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
  };
}

afterEach(() => resetPlaybackSessionForTest());

describe("playback session (#1764)", () => {
  it("asks for a playback audio session and loops a silent element", () => {
    const nav = { audioSession: { type: "auto" } };
    const el = fakeElement();
    enterPlaybackSession(nav, () => el);
    expect(nav.audioSession.type).toBe("playback");
    expect(el.loop).toBe(true);
    expect(el.src.startsWith("data:audio/wav;base64,")).toBe(true);
    expect(el.play).toHaveBeenCalledTimes(1);
  });

  it("reuses one element across plays and pauses it on leave", () => {
    const el = fakeElement();
    const create = vi.fn(() => el);
    enterPlaybackSession({}, create);
    enterPlaybackSession({}, create);
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
    expect(() => enterPlaybackSession(nav, () => null)).not.toThrow();
    const rejecting = fakeElement();
    rejecting.play = vi.fn(() => Promise.reject(new Error("autoplay")));
    resetPlaybackSessionForTest();
    expect(() => enterPlaybackSession({}, () => rejecting)).not.toThrow();
  });

  it("builds a valid 0.1 s silent WAV", () => {
    const uri = silentWavDataUri();
    const bytes = Uint8Array.from(atob(uri.split(",")[1]!), (c) =>
      c.charCodeAt(0),
    );
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    expect(bytes.length).toBe(44 + 1600);
    expect(bytes.slice(44).every((b) => b === 0)).toBe(true);
  });
});
