import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands, execute } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import type { TrackView } from "../../types/project";
import { TrackInspector } from "./TrackInspector";

const setTrackMetaCommand = vi.fn();

vi.mock("../../api", () => ({
  setTrackMetaCommand: (...args: unknown[]) => setTrackMetaCommand(...args),
  setEffectBypass: vi.fn(),
}));

const hostTrack: TrackView = {
  id: "host",
  label: "Host",
  role: "dialogue",
  speaker: null,
  gain_db: 0,
  muted: false,
  duration_sec: 10,
  fx_count: 0,
  stem_is_fresh: true,
};

describe("TrackInspector", () => {
  beforeEach(() => {
    setTrackMetaCommand.mockReset();
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore
      .getState()
      .hydrate("/tmp/ep.json", minimalProject({ tracks: [hostTrack] }));
  });

  afterEach(() => {
    clearRegisteredCommands();
  });

  it("applies SetTrackMeta locally before the command resolves and reverts on failure", async () => {
    const user = userEvent.setup();
    let release!: (err?: Error) => void;
    const held = new Promise<Record<string, unknown>>((_, reject) => {
      release = (err?: Error) => {
        reject(err ?? new Error("network"));
      };
    });
    setTrackMetaCommand.mockImplementation(async () => held);

    render(<TrackInspector track={hostTrack} effects={[]} />);
    const input = screen.getByDisplayValue("Host");
    await user.clear(input);
    await user.type(input, "Narrator");
    expect(useDawStore.getState().project?.tracks[0]?.label).toBe("Host");
    await user.tab();
    expect(useDawStore.getState().project?.tracks[0]?.label).toBe("Narrator");
    expect(setTrackMetaCommand).toHaveBeenCalled();

    release(new Error("network"));
    await vi.waitFor(() => {
      expect(useDawStore.getState().project?.tracks[0]?.label).toBe("Host");
    });
  });

  it("does not switch a guest to FX via Play FX around start", async () => {
    useDawStore
      .getState()
      .hydrate("/tmp/ep.json", minimalProject({ tracks: [hostTrack] }), "view");
    render(<TrackInspector track={hostTrack} effects={[]} />);
    const playFx = screen.getByRole("button", { name: "Play FX around start" });
    expect(playFx).toBeDisabled();
    expect(await execute("transport.audition", { mode: "fx" })).toEqual({
      status: "disabled",
      reason: "guests hear Mix only",
    });
    expect(useDawStore.getState().auditionMode).toBe("mix");
  });
});
