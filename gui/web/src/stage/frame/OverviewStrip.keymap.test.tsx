import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawKeymapListener } from "../../keymap/listener";
import { useDawStore } from "../../state/dawStore";
import { OverviewStrip } from "../../system/OverviewStrip";
import { minimalProject } from "../../test/fixtures";
import { useSeekFraction } from "./useSeekFraction";

const DURATION = 100;

function Connected() {
  useDawKeymapListener();
  const playheadSec = useDawStore((s) => s.playheadSec);
  return (
    <OverviewStrip
      height={64}
      label="Episode overview"
      playhead={playheadSec / DURATION}
      duration={DURATION}
      onSeek={useSeekFraction(DURATION)}
    />
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate(
      "/tmp/strip-keys/episode.sharecut",
      minimalProject({ timeline_duration_sec: DURATION }),
    );
  useDawStore.setState({ playheadSec: 0, isPlaying: false });
});

afterEach(() => {
  clearRegisteredCommands();
});

describe("OverviewStrip with the global keymap", () => {
  it.each([
    ["ArrowRight", false, 1],
    ["ArrowRight", true, 10],
    ["End", false, DURATION],
  ])(
    "%s (shift %s) moves the playhead once, to %s s",
    async (key, shiftKey, sec) => {
      render(<Connected />);
      fireEvent.keyDown(screen.getByRole("slider"), {
        key,
        code: key,
        shiftKey,
      });
      await settle();
      expect(useDawStore.getState().playheadSec).toBe(sec);
    },
  );

  it("ignores the arrows while a drag is moving", async () => {
    render(<Connected />);
    const strip = screen.getByRole("slider");
    strip.getBoundingClientRect = () =>
      ({ left: 0, width: 400, right: 400 }) as DOMRect;
    fireEvent.pointerDown(strip, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(strip, { pointerId: 1, clientX: 200 });
    await settle();
    expect(useDawStore.getState().playheadSec).toBe(50);
    fireEvent.keyDown(strip, { key: "ArrowRight", code: "ArrowRight" });
    await settle();
    expect(useDawStore.getState().playheadSec).toBe(50);
  });
});
