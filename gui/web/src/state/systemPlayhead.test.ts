import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "./dawStore";
import { pauseFromSystem, syncPlayhead } from "./systemPlayhead";

beforeEach(() => {
  useDawStore.setState({
    playheadSec: 40,
    playheadSeekRevision: 7,
    isPlaying: true,
    sourcePreview: null,
  });
});

afterEach(() => {
  useDawStore.setState({
    isPlaying: false,
    playheadSec: 0,
    sourcePreview: null,
  });
});

describe("syncPlayhead", () => {
  it("moves the playhead without bumping the seek revision", () => {
    syncPlayhead(88);
    expect(useDawStore.getState().playheadSec).toBe(88);
    expect(useDawStore.getState().playheadSeekRevision).toBe(7);
  });
});

describe("pauseFromSystem", () => {
  it("pauses at the given second without bumping the seek revision", () => {
    pauseFromSystem(52.5);
    const state = useDawStore.getState();
    expect(state.isPlaying).toBe(false);
    expect(state.playheadSec).toBe(52.5);
    expect(state.playheadSeekRevision).toBe(7);
  });

  it.each([true, false])(
    "ignores an episode pause while a source preview is held (playing: %s)",
    (playing) => {
      useDawStore.setState({
        sourcePreview: {
          ownerId: "wordbar",
          projectEpoch: useDawStore.getState().projectEpoch,
          generation: 1,
          media: { kind: "rendered", url: "/preview.wav" },
          startSec: 1,
          endSec: 2,
          playing,
        },
      });

      pauseFromSystem(90);

      expect(useDawStore.getState()).toMatchObject({
        isPlaying: true,
        playheadSec: 40,
        playheadSeekRevision: 7,
        sourcePreview: { playing },
      });
    },
  );

  it("does nothing when the transport is not playing", () => {
    useDawStore.setState({ isPlaying: false });
    pauseFromSystem(90);
    expect(useDawStore.getState().playheadSec).toBe(40);
  });
});
