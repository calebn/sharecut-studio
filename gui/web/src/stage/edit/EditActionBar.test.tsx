import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveSpeakerLaneSpan } from "../../api/speakerMoveLaneSpan";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { clearClipboard } from "../../edit/clipboard";
import { makeRangeTarget } from "../../edit/rangeSelection";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  EDIT_SELECTIONS,
  editFixtureProject,
  JONAS,
  MIRA,
} from "../../test/actionBarFixtures";
import { clipRow, minimalProject, sampleTrack } from "../../test/fixtures";
import { EditActionBar } from "./EditActionBar";

vi.mock("../../api/speakerMoveLaneSpan", () => ({
  moveSpeakerLaneSpan: vi.fn(),
}));
vi.mock("../../document/applyDocumentUpdate", () => ({
  refreshDocumentProject: vi.fn(async () => minimalProject()),
}));

function host(selection: unknown, extra: Record<string, unknown> = {}) {
  useDawStore.setState({
    project: editFixtureProject(),
    projectPath: "/tmp/episode",
    guestMode: null,
    shareCapabilities: null,
    selection: selection as never,
    rangeArmed: false,
    rangeBusy: false,
    joinMutationInFlight: false,
    sessionRegion: null,
    inspectorKey: null,
    playheadSec: 8,
    statusAnnouncement: "",
    ...extra,
  });
}

const names = () => screen.getAllByRole("button").map((b) => b.textContent);

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  clearClipboard();
});
afterEach(() => vi.restoreAllMocks());

describe("EditActionBar on the phone dock", () => {
  it("shows the playhead verbs when nothing is selected", async () => {
    host(EDIT_SELECTIONS.playhead);
    const { container } = render(<EditActionBar form="dock" root={null} />);
    expect(names()).toEqual(["Split", "Add chapter", "Record"]);
    await expectNoA11yViolations(container);
  });

  it("offers Paste at the playhead only when the clipboard holds audio", async () => {
    const { setClipboard } = await import("../../edit/clipboard");
    setClipboard({
      timelineStart: 0,
      timelineEnd: 1,
      mode: "copy",
      extracts: [],
    });
    host(EDIT_SELECTIONS.playhead);
    render(<EditActionBar form="dock" root={null} />);
    expect(names()).toContain("Paste");
  });

  it("a range leads with its scope, ends with Cut and passes axe", async () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    const { container } = render(<EditActionBar form="dock" root={null} />);
    const bar = screen.getByRole("group", { name: "Edit actions" });
    expect(within(bar).getByTitle("Change the tracks")).toBeTruthy();
    expect(names().at(-1)).toBe("Cut");
    for (const verb of ["Hear", "Split", "Comment", "Record"]) {
      expect(
        within(bar).getByRole("button", { name: new RegExp(`^${verb}`) }),
      ).toBeTruthy();
    }
    await expectNoA11yViolations(container);
  });

  it("counts several selected clips in the leading slot", () => {
    host(EDIT_SELECTIONS.clips);
    render(<EditActionBar form="dock" root={null} />);
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  it("gives a read-only share Hear (the full mix) and Comment only", () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks, {
      projectPath: "share:token",
      guestMode: "view",
      shareCapabilities: ["view", "play"],
    });
    render(<EditActionBar form="dock" root={null} />);
    expect(names()).toEqual(["Play full mix", "Comment"]);
  });

  it("words the suggest guest's Cut and Mute as suggestions", async () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks, {
      projectPath: "share:token",
      guestMode: "comment",
      shareCapabilities: ["view", "play", "comment", "suggest"],
    });
    render(<EditActionBar form="dock" root={null} />);
    expect(names().at(-1)).toBe("Suggest cut");
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(
      screen.getByRole("menuitem", { name: "Suggest mute" }),
    ).toBeInTheDocument();
  });

  it("disables Cut with the busy reason while a range action runs", () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks, { rangeBusy: true });
    render(<EditActionBar form="dock" root={null} />);
    const cut = screen.getByRole("button", { name: "Cut" });
    expect(cut).toBeDisabled();
    expect(cut).toHaveAttribute("title", "Range action in progress");
  });

  it("says why Split did nothing when the playhead is off the clip", async () => {
    host(EDIT_SELECTIONS.clip, { playheadSec: 9 });
    render(<EditActionBar form="dock" root={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Move the playhead onto the clip to split it",
    );
  });

  it("makes Inspect the dock's grip, and it opens the Inspector for the selection", async () => {
    host(EDIT_SELECTIONS.clip);
    render(<EditActionBar form="dock" root={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect(useDawStore.getState().inspectorKey).toBe(`clip:${"a"}`);
  });

  it("gives every verb button its key for assistive tech", () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    render(<EditActionBar form="dock" root={null} />);
    expect(screen.getByRole("button", { name: "Hear" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Shift+Space",
    );
    expect(screen.getByRole("button", { name: "Split" })).toHaveAttribute(
      "aria-keyshortcuts",
      "S",
    );
  });

  it("toggles a range between every dialogue track and the one it began on", async () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    render(<EditActionBar form="dock" root={null} />);
    await userEvent.click(screen.getByTitle("Change the tracks"));
    const narrowed = useDawStore.getState().selection;
    expect(narrowed).toMatchObject({ kind: "range" });
    expect(
      narrowed?.kind === "range" ? narrowed.target.track_ids : [],
    ).toHaveLength(1);
    await userEvent.click(screen.getByTitle("Change the tracks"));
    const widened = useDawStore.getState().selection;
    expect(widened?.kind === "range" ? widened.target.track_ids : []).toEqual([
      MIRA,
      JONAS,
    ]);
  });
});

const splitLanes = () => {
  const ana = sampleTrack({
    id: "room",
    label: "Ana",
    speaker_split_id: "split_1",
    range_media_seal: "room",
  });
  const ben = sampleTrack({
    id: "room_ben",
    label: "Ben",
    speaker_split_id: "split_1",
    range_media_seal: "room_ben",
  });
  const project = minimalProject({
    tracks: [ana, ben],
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
  return {
    project,
    target: makeRangeTarget(project, [{ start: 1, end: 1.4 }], ["room"])!,
  };
};

describe("EditActionBar More rows", () => {
  it("moves the selected range through the host API", async () => {
    const { project, target } = splitLanes();
    host({ kind: "range", target }, { project });
    vi.mocked(moveSpeakerLaneSpan).mockResolvedValue({
      from_lane: "room",
      to_lane: "room_ben",
      source_start: 1,
      source_end: 1.4,
      words_moved: 1,
      history_head_id: "head_move",
    });
    render(<EditActionBar form="dock" root={null} />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Move to Ben" }),
    );
    expect(moveSpeakerLaneSpan).toHaveBeenCalledWith("/tmp/episode", {
      fromLane: "room",
      toLane: "room_ben",
      timelineStart: 1,
      timelineEnd: 1.4,
    });
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      undo: "head_move",
    });
  });

  it("disables the speaker move for a guest, with the reason", async () => {
    const { project, target } = splitLanes();
    host(
      { kind: "range", target },
      {
        project,
        projectPath: "share:token",
        guestMode: "edit",
        shareCapabilities: ["view", "play", "comment", "suggest", "edit"],
      },
    );
    render(<EditActionBar form="dock" root={null} />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(
      screen.getByRole("menuitem", { name: "Move to Ben" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("opens More when the . key asks for it", () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    render(<EditActionBar form="dock" root={null} />);
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => useDawStore.getState().requestMore());
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});

function Floating() {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  return (
    <div ref={setRoot}>
      <div className="lane-row" data-track-id={MIRA}>
        <div className="lane-inner">
          <div className="range-overlay" />
        </div>
      </div>
      <EditActionBar form="floating" root={root} />
    </div>
  );
}

describe("EditActionBar floating", () => {
  it("floats beside the selection and not at all with nothing selected", () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    const { unmount } = render(<Floating />);
    expect(
      screen.getByRole("group", { name: "Selection actions" }),
    ).toBeInTheDocument();
    unmount();
    host(EDIT_SELECTIONS.playhead);
    render(<Floating />);
    expect(
      screen.queryByRole("group", { name: "Selection actions" }),
    ).toBeNull();
  });

  it("hides while its anchor is scrolled out of view and returns with it", () => {
    let report: (visible: boolean) => void = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
          report = (visible) => cb([{ isIntersecting: visible }]);
        }
        observe() {}
        disconnect() {}
      },
    );
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    render(<Floating />);
    act(() => report(false));
    expect(
      screen.queryByRole("group", { name: "Selection actions" }),
    ).toBeNull();
    act(() => report(true));
    expect(
      screen.getByRole("group", { name: "Selection actions" }),
    ).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("runs a verb on click through the command bus", async () => {
    host(EDIT_SELECTIONS.clip, { playheadSec: 9 });
    const { container } = render(<Floating />);
    fireEvent.click(within(container).getByRole("button", { name: "Split" }));
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toContain("playhead"),
    );
  });
});
