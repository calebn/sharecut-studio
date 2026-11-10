import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type { HistoryEntryId } from "../types/project";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  extractRoomToneBedCommand: vi.fn(),
  clearExtractedRoomToneBedCommand: vi.fn(),
}));

const HEAD = "h1" as HistoryEntryId;

function load(track: Parameters<typeof sampleTrack>[0], path = "/tmp/ep.json") {
  useDawStore
    .getState()
    .hydrate(path, minimalProject({ tracks: [sampleTrack(track)] }));
}

function toastText(): string | undefined {
  return useDawStore.getState().feedbackToast?.message;
}

describe("room tone commands", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(api.extractRoomToneBedCommand).mockReset();
    vi.mocked(api.clearExtractedRoomToneBedCommand).mockReset();
    useDawStore.setState({ selection: null, feedbackToast: null });
  });

  it("extracts for the track in its args and offers Undo", async () => {
    load({ id: "host", label: "Host" });
    vi.mocked(api.extractRoomToneBedCommand).mockResolvedValue({
      done: true,
      historyHead: HEAD,
    });
    expect(
      await execute(
        "track.extractRoomTone",
        { trackId: "host" },
        { skipWhen: true },
      ),
    ).toEqual({ status: "ok" });
    expect(api.extractRoomToneBedCommand).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "host",
    );
    expect(toastText()).toBe("Cut room tone from Host");
    expect(useDawStore.getState().feedbackToast?.undo).toBe(HEAD);
  });

  it("falls back to the track the inspector shows", async () => {
    load({ id: "host" });
    useDawStore.setState({ selection: { kind: "track", trackId: "host" } });
    vi.mocked(api.clearExtractedRoomToneBedCommand).mockResolvedValue({
      done: true,
      historyHead: HEAD,
    });
    await execute("track.clearRoomTone", {}, { skipWhen: true });
    expect(api.clearExtractedRoomToneBedCommand).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "host",
    );
    expect(toastText()).toBe("Removed room tone from host");
    expect(useDawStore.getState().feedbackToast?.undo).toBe(HEAD);
  });

  it.each([
    ["no_quiet_run", "Host has no stretch quiet enough to use"],
    ["has_bed", "Host already has a room tone that was recorded or assigned"],
    ["already_extracted", "Host already has a room tone cut from this audio"],
    ["missing_track", "Host is no longer in this project"],
    ["missing_file", "Host has an audio file that could not be found"],
    [
      "source_changed",
      "Host had its audio change while room tone was being cut, so try again",
    ],
    [
      "bed_changed",
      "Host has a room tone file that changed on disk, so it was left alone",
    ],
    ["unreadable_file", "Host has audio that could not be read, so try again"],
    [
      "gated_live",
      "Host is still being recorded, so try again when it has finished",
    ],
  ])(
    "says in plain words why an extract did nothing: %s",
    async (reason, text) => {
      load({ id: "host", label: "Host" });
      vi.mocked(api.extractRoomToneBedCommand).mockResolvedValue({
        done: false,
        reason,
      });
      expect(
        await execute(
          "track.extractRoomTone",
          { trackId: "host" },
          { skipWhen: true },
        ),
      ).toEqual({ status: "disabled", reason: text, told: true });
      expect(toastText()).toBe(text);
      expect(useDawStore.getState().feedbackToast?.undo ?? null).toBeNull();
    },
  );

  it("tells a failed send as an error and sends nothing twice at once", async () => {
    load({ id: "host", label: "Host" });
    let release: (v: { done: true; historyHead: null }) => void = () => {};
    vi.mocked(api.extractRoomToneBedCommand).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = execute(
      "track.extractRoomTone",
      { trackId: "host" },
      { skipWhen: true },
    );
    expect(
      await execute(
        "track.extractRoomTone",
        { trackId: "host" },
        { skipWhen: true },
      ),
    ).toEqual({ status: "disabled", reason: "Room tone is already changing" });
    release({ done: true, historyHead: null });
    await first;
    expect(api.extractRoomToneBedCommand).toHaveBeenCalledTimes(1);

    vi.mocked(api.clearExtractedRoomToneBedCommand).mockRejectedValue(
      new Error("boom"),
    );
    const failed = await execute(
      "track.clearRoomTone",
      { trackId: "host" },
      { skipWhen: true },
    );
    expect(failed).toMatchObject({ status: "disabled", reason: "boom" });
    expect(toastText()).toContain("Remove room tone failed");
  });

  it("clears on a track with no audio", async () => {
    load({ id: "host", media_path: null });
    vi.mocked(api.clearExtractedRoomToneBedCommand).mockResolvedValue({
      done: true,
      historyHead: HEAD,
    });
    expect(
      await execute(
        "track.clearRoomTone",
        { trackId: "host" },
        { skipWhen: true },
      ),
    ).toEqual({ status: "ok" });
    expect(api.clearExtractedRoomToneBedCommand).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "host",
    );
  });

  it("is refused without audio and on a review link", async () => {
    load({ id: "host", media_path: null });
    expect(
      await execute(
        "track.extractRoomTone",
        { trackId: "host" },
        { skipWhen: true },
      ),
    ).toEqual({ status: "disabled", reason: "Import audio first" });
    load({ id: "host" }, shareProjectKey("tok"));
    expect(
      await execute(
        "track.extractRoomTone",
        { trackId: "host" },
        { skipWhen: true },
      ),
    ).toEqual({
      status: "disabled",
      reason: "Only the host can change room tone",
    });
    expect(api.extractRoomToneBedCommand).not.toHaveBeenCalled();
  });
});
