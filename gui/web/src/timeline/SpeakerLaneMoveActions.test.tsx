import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { moveSpeakerLaneSpan } from "../api/speakerMoveLaneSpan";
import { clearRegisteredCommands } from "../commands/execute";
import {
  registerSpeakerMoveLaneSpanCommands,
  runMoveSpeakerLaneSpan,
} from "../commands/speakerMoveLaneSpan";
import { makeRangeTarget } from "../edit/rangeSelection";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { SpeakerLaneMoveActions } from "./SpeakerLaneMoveActions";

vi.mock("../api/speakerMoveLaneSpan", () => ({
  moveSpeakerLaneSpan: vi.fn(),
}));
vi.mock("../document/applyDocumentUpdate", () => ({
  refreshDocumentProject: vi.fn(async () => minimalProject()),
}));

const host = sampleTrack({
  id: "room",
  label: "Ana",
  speaker_split_id: "split_1",
  range_media_seal: "room",
});
const guest = sampleTrack({
  id: "room_ben",
  label: "Ben",
  speaker_split_id: "split_1",
  range_media_seal: "room_ben",
});
const project = minimalProject({
  tracks: [host, guest],
  clips: {
    tracks: {
      room: [
        clipRow({
          id: "c1",
          track_id: "room",
          timeline_start: 0,
          timeline_end: 10,
          source_start: 0,
          source_end: 10,
        }),
      ],
      room_ben: [
        clipRow({
          id: "c2",
          track_id: "room_ben",
          timeline_start: 0,
          timeline_end: 10,
          source_start: 0,
          source_end: 10,
        }),
      ],
    },
    clip_count: 2,
  },
});
const target = makeRangeTarget(project, [{ start: 1, end: 1.4 }], ["room"])!;

beforeEach(() => {
  vi.mocked(moveSpeakerLaneSpan).mockReset();
  vi.mocked(moveSpeakerLaneSpan).mockResolvedValue({
    from_lane: "room",
    to_lane: "room_ben",
    source_start: 1,
    source_end: 1.4,
    words_moved: 1,
    history_head_id: "head_move",
  });
  clearRegisteredCommands();
  registerSpeakerMoveLaneSpanCommands();
  useDawStore.setState({
    project,
    projectPath: "/tmp/ep",
    guestMode: null,
    shareCapabilities: null,
    selection: { kind: "range", target },
    rangeBusy: false,
    joinMutationInFlight: false,
    projectEpoch: 1,
  });
});

describe("SpeakerLaneMoveActions", () => {
  it("offers a sibling lane control and passes axe", async () => {
    const { container } = render(<SpeakerLaneMoveActions />);
    const button = screen.getByRole("button", { name: "Move to Ben" });
    expect(button).toBeVisible();
    await expectNoA11yViolations(container);
    fireEvent.click(button);
    await waitFor(() => expect(moveSpeakerLaneSpan).toHaveBeenCalled());
    expect(moveSpeakerLaneSpan).toHaveBeenCalledWith("/tmp/ep", {
      fromLane: "room",
      toLane: "room_ben",
      timelineStart: 1,
      timelineEnd: 1.4,
    });
  });
  it("moves the selected range through the host API", async () => {
    const result = await runMoveSpeakerLaneSpan("room_ben");
    expect(result.status).toBe("ok");
    expect(moveSpeakerLaneSpan).toHaveBeenCalledWith("/tmp/ep", {
      fromLane: "room",
      toLane: "room_ben",
      timelineStart: 1,
      timelineEnd: 1.4,
    });
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      undo: "head_move",
    });
  });
  it("disables move for guests", () => {
    useDawStore.setState({ projectPath: "share:token", guestMode: "edit" });
    render(<SpeakerLaneMoveActions />);
    expect(screen.getByRole("button", { name: "Move to Ben" })).toBeDisabled();
  });
});
