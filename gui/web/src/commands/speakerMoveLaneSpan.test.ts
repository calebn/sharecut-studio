import { beforeEach, describe, expect, it, vi } from "vitest";
import { moveSpeakerLaneSpan } from "../api/speakerMoveLaneSpan";
import { makeRangeTarget } from "../edit/rangeSelection";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { runAndAnnounceRefusal } from "./refusal";
import { registerSpeakerMoveLaneSpanCommands } from "./speakerMoveLaneSpan";

vi.mock("../api/speakerMoveLaneSpan", () => ({
  moveSpeakerLaneSpan: vi.fn(),
}));

const project = minimalProject({
  tracks: [
    sampleTrack({ id: "ana", speaker_split_id: "split" }),
    sampleTrack({ id: "ben", speaker_split_id: "split" }),
  ],
  clips: {
    tracks: {
      ana: [
        clipRow({
          id: "ana-clip",
          track_id: "ana",
          timeline_start: 0,
          timeline_end: 10,
          source_start: 0,
          source_end: 10,
        }),
      ],
      ben: [],
    },
    clip_count: 1,
  },
});
const target = makeRangeTarget(project, [{ start: 1, end: 2 }], ["ana"])!;

describe("range.moveSpeakerLane refusal feedback", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerSpeakerMoveLaneSpanCommands();
    vi.mocked(moveSpeakerLaneSpan).mockReset();
    vi.mocked(moveSpeakerLaneSpan).mockRejectedValue(new Error("move failed"));
    useDawStore.setState({
      project,
      projectPath: "/tmp/ep",
      stage: "edit",
      guestMode: null,
      shareCapabilities: null,
      projectEpoch: 1,
      selection: { kind: "range", target },
      rangeBusy: false,
      joinMutationInFlight: false,
      statusAnnouncement: "",
    });
  });

  it("marks the current-epoch failure already announced", async () => {
    const announced = vi.spyOn(useDawStore.getState(), "announceStatus");
    const result = await runAndAnnounceRefusal(() =>
      execute("range.moveSpeakerLane", { toLaneId: "ben" }),
    );
    expect(result).toEqual({
      status: "disabled",
      reason: "move failed",
      told: true,
    });
    expect(announced).toHaveBeenCalledTimes(1);
    expect(announced).toHaveBeenCalledWith("move failed", { tone: "error" });
    expect(useDawStore.getState().statusAnnouncement).toBe("move failed");
  });

  it("does not claim acknowledgement for a stale-epoch failure", async () => {
    const failure = deferred<never>();
    vi.mocked(moveSpeakerLaneSpan).mockReturnValueOnce(failure.promise);
    const announced = vi.spyOn(useDawStore.getState(), "announceStatus");
    const pending = execute("range.moveSpeakerLane", { toLaneId: "ben" });
    await vi.waitFor(() =>
      expect(moveSpeakerLaneSpan).toHaveBeenCalledTimes(1),
    );
    useDawStore.setState({ projectEpoch: 2 });
    failure.reject(new Error("stale move failed"));

    expect(await pending).toEqual({
      status: "disabled",
      reason: "stale move failed",
    });
    expect(announced).not.toHaveBeenCalled();
  });
});
