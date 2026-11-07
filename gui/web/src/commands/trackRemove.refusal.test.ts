import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { runAndAnnounceRefusal } from "./refusal";
import { registerDawCommands } from "./register";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  removeTrackCommand: vi.fn(),
}));

describe("track.remove refusal ownership", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(api.removeTrackCommand).mockReset();
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      shareCapabilities: null,
      project: minimalProject({
        tracks: [
          {
            id: "host",
            label: "Host",
            role: "dialogue",
            speaker: null,
            gain_db: 0,
            muted: false,
            duration_sec: 10,
            fx_count: 0,
            stem_is_fresh: true,
          },
        ],
      }),
      selection: { kind: "track", trackId: "host" },
    });
  });

  it("preserves its announced failure through the refusal wrapper", async () => {
    vi.mocked(api.removeTrackCommand).mockRejectedValueOnce(
      new Error("Server unreachable"),
    );
    const announce = vi.spyOn(useDawStore.getState(), "announceStatus");

    const result = await runAndAnnounceRefusal(() =>
      execute("track.remove", {}, { skipWhen: true }),
    );

    expect(api.removeTrackCommand).toHaveBeenCalledWith("/tmp/ep", "host");
    expect(result).toEqual({
      status: "disabled",
      reason: "Server unreachable",
      told: true,
    });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("Remove failed: Server unreachable", {
      tone: "error",
    });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Remove failed: Server unreachable",
    );
  });
});
