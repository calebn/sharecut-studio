import { act, renderHook } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { SegmentRow } from "../api/segments";
import { stopAudition, toggleAudition, useAudition } from "./audition";

vi.mock("../sessionAuth", () => ({
  withSessionTokenQuery: (url: string) => `${url}&token=t`,
}));

const play = vi.fn<() => Promise<void>>();
const pause = vi.fn();
const load = vi.fn();
const instances: HTMLAudioElement[] = [];

function row(id: string, clips = 1, version = 1): SegmentRow {
  return {
    id,
    name: id,
    kind: "intro",
    version,
    versions: [version],
    clips: Array.from({ length: clips }, (_, i) => ({
      audio: `c${i}.flac`,
      offset_sec: i * 3,
      duration_sec: 3,
    })),
  };
}

const audioElement = () => instances[0];

beforeAll(() => {
  class FakeAudio extends EventTarget {
    preload = "";
    private srcValue: string | null = null;
    constructor() {
      super();
      instances.push(this as unknown as HTMLAudioElement);
    }
    get src() {
      return this.srcValue ?? "";
    }
    set src(value: string) {
      this.srcValue = value;
    }
    removeAttribute() {
      this.srcValue = null;
    }
    play = play;
    pause = pause;
    load = load;
  }
  vi.stubGlobal("Audio", FakeAudio);
});

beforeEach(() => {
  play.mockReset().mockResolvedValue(undefined);
  pause.mockReset();
  load.mockReset();
});

afterEach(() => {
  act(() => stopAudition());
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("audition", () => {
  it("plays the first clip with preload none, building the URL at the click", () => {
    toggleAudition(row("intro-1", 1, 2), "a");
    const element = audioElement();
    expect(element.preload).toBe("none");
    expect(element.src).toContain(
      "/api/segments/intro-1/audio?clip=0&version=2",
    );
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("uses one shared element for every row", () => {
    toggleAudition(row("a"), "a");
    toggleAudition(row("b"), "a");
    expect(instances).toHaveLength(1);
    expect(audioElement().src).toContain("/api/segments/b/audio");
  });

  it("stops on a second tap of the same row", () => {
    const { result } = renderHook(() => useAudition());
    act(() => toggleAudition(row("a"), "a"));
    expect(result.current.playingId).toBe("a");
    act(() => toggleAudition(row("a"), "a"));
    expect(result.current.playingId).toBeNull();
    expect(pause).toHaveBeenCalled();
  });

  it("switches to another row without two playing at once", () => {
    const { result } = renderHook(() => useAudition());
    act(() => toggleAudition(row("a"), "a"));
    act(() => toggleAudition(row("b"), "a"));
    expect(result.current.playingId).toBe("b");
  });

  it("moves to the next clip on ended, then stops after the last", () => {
    const { result } = renderHook(() => useAudition());
    act(() => toggleAudition(row("a", 2), "a"));
    const element = audioElement();
    act(() => {
      element.dispatchEvent(new Event("ended"));
    });
    expect(element.src).toContain("clip=1");
    expect(result.current.playingId).toBe("a");
    act(() => {
      element.dispatchEvent(new Event("ended"));
    });
    expect(result.current.playingId).toBeNull();
  });

  it("marks the row failed on an error event", () => {
    const { result } = renderHook(() => useAudition());
    act(() => toggleAudition(row("a"), "a"));
    act(() => {
      audioElement().dispatchEvent(new Event("error"));
    });
    expect(result.current).toEqual({
      playingId: null,
      failedId: "a",
      owner: "a",
    });
  });

  it("marks the row failed when play is refused, and clears it on the next play", async () => {
    play.mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    const { result } = renderHook(() => useAudition());
    await act(async () => toggleAudition(row("a"), "a"));
    expect(result.current.failedId).toBe("a");
    act(() => toggleAudition(row("b"), "a"));
    expect(result.current).toEqual({
      playingId: "b",
      failedId: null,
      owner: "a",
    });
  });

  it("fails a segment with no clips instead of playing nothing", () => {
    const { result } = renderHook(() => useAudition());
    act(() => toggleAudition(row("empty", 0), "a"));
    expect(result.current.failedId).toBe("empty");
    expect(play).not.toHaveBeenCalled();
  });

  it("stops on pagehide", () => {
    const { result } = renderHook(() => useAudition());
    act(() => toggleAudition(row("a"), "a"));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(result.current.playingId).toBeNull();
  });

  it("stops for its owner only when an owner is named", () => {
    const { result } = renderHook(() => useAudition());
    act(() => toggleAudition(row("a"), "home"));
    act(() => stopAudition("sheet"));
    expect(result.current.playingId).toBe("a");
    act(() => stopAudition("home"));
    expect(result.current.playingId).toBeNull();
  });

  it("holds the pagehide listener only while something plays", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    act(() => toggleAudition(row("a"), "a"));
    act(() => toggleAudition(row("b"), "a"));
    act(() => stopAudition());
    const added = add.mock.calls.filter(([type]) => type === "pagehide");
    const removed = remove.mock.calls.filter(([type]) => type === "pagehide");
    expect(added.length).toBeGreaterThan(0);
    expect(removed.at(-1)?.[1]).toBe(added[0][1]);
    add.mockRestore();
    remove.mockRestore();
  });
});
