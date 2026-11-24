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
import {
  COMMENTER_CAPABILITIES,
  clipRow,
  minimalProject,
  sampleTrack,
} from "../../test/fixtures";
import { BounceRunContext } from "../hosts/bounceRunnerContext";
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
    expect(names()).toEqual([
      "Split",
      "Add chapter",
      "Record here",
      "Export",
      "More",
    ]);
    await expectNoA11yViolations(container);
  });

  it("opens the Export options from More with the saved source and MP3", async () => {
    host(EDIT_SELECTIONS.playhead);
    render(<EditActionBar form="dock" root={null} />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Export options" }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Export options" });
    expect(
      within(sheet).getByRole("button", { name: "Full mix" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(sheet).getByRole("button", { name: "Also MP3" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("reads Cancel export, pressed, while a bounce runs", () => {
    host(EDIT_SELECTIONS.playhead);
    render(
      <BounceRunContext.Provider
        value={{ kind: "running", jobId: "b1", cancelling: false }}
      >
        <EditActionBar form="dock" root={null} />
      </BounceRunContext.Provider>,
    );
    expect(
      screen.getByRole("button", { name: "Cancel export" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("disables Cancel export until the job has an id and once cancelling", () => {
    host(EDIT_SELECTIONS.playhead);
    const view = (run: { jobId: string | null; cancelling: boolean }) => (
      <BounceRunContext.Provider value={{ kind: "running", ...run }}>
        <EditActionBar form="dock" root={null} />
      </BounceRunContext.Provider>
    );
    const cancel = () => screen.getByRole("button", { name: "Cancel export" });
    const { rerender } = render(view({ jobId: null, cancelling: false }));
    expect(cancel()).toBeDisabled();
    rerender(view({ jobId: "b1", cancelling: false }));
    expect(cancel()).toBeEnabled();
    rerender(view({ jobId: "b1", cancelling: true }));
    expect(cancel()).toBeDisabled();
  });

  it("disables Export when another export starts and enables it when that ends", () => {
    host(EDIT_SELECTIONS.playhead, { activityJob: null });
    render(<EditActionBar form="dock" root={null} />);
    const exportButton = () => screen.getByRole("button", { name: "Export" });
    expect(exportButton()).toBeEnabled();

    act(() =>
      useDawStore.setState({
        activityJob: { id: "p1", kind: "pipeline", status: "running" } as never,
      }),
    );
    expect(exportButton()).toBeDisabled();

    act(() => useDawStore.setState({ activityJob: null }));
    expect(exportButton()).toBeEnabled();
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
    for (const verb of ["Hear", "Split", "Comment", "Re-record"]) {
      expect(
        within(bar).getByRole("button", { name: new RegExp(`^${verb}`) }),
      ).toBeTruthy();
    }
    await expectNoA11yViolations(container);
  });

  it("labels Record exactly Re-record on a replaceable range", () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    render(<EditActionBar form="dock" root={null} />);
    const bar = screen.getByRole("group", { name: "Edit actions" });
    expect(
      within(bar).getAllByRole("button", { name: /Re-record/ }),
    ).toHaveLength(1);
    expect(names()).toContain("Re-record");
    expect(names()).not.toContain("Record here");
  });

  it("has no Record button on a range that ends past the timeline", () => {
    const project = editFixtureProject();
    host(EDIT_SELECTIONS.rangeOnAllTracks, {
      project: {
        ...project,
        timeline_duration_sec: 1.5,
      },
    });
    render(<EditActionBar form="dock" root={null} />);
    expect(names().filter((n) => /record/i.test(n ?? ""))).toEqual([]);
  });

  it("names several selected clips in the leading slot", () => {
    host(EDIT_SELECTIONS.clips);
    render(<EditActionBar form="dock" root={null} />);
    expect(screen.getByText("3 clips")).toBeInTheDocument();
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

  it.each([
    ["a decision", { pendingDecisionInFlight: "pending-cut" }],
    [
      "an edge retime of that suggestion",
      { pendingRetimeInFlight: "pending-cut" },
    ],
  ])(
    "disables a suggestion's Cut and Keep as %s starts and lifts them as it ends",
    (_name, busy) => {
      host(EDIT_SELECTIONS.suggestion, {
        pendingDecisionInFlight: null,
        pendingRetimeInFlight: null,
      });
      render(<EditActionBar form="dock" root={null} />);
      const cut = () => screen.getByRole("button", { name: "Cut" });
      const keep = () => screen.getByRole("button", { name: "Keep" });
      expect(cut()).toBeEnabled();
      expect(keep()).toBeEnabled();
      act(() => useDawStore.setState(busy));
      expect(cut()).toBeDisabled();
      expect(keep()).toBeDisabled();
      act(() =>
        useDawStore.setState({
          pendingDecisionInFlight: null,
          pendingRetimeInFlight: null,
        }),
      );
      expect(cut()).toBeEnabled();
      expect(keep()).toBeEnabled();
    },
  );

  it("leaves Cut and Keep alone while another suggestion retimes", () => {
    host(EDIT_SELECTIONS.suggestion, { pendingRetimeInFlight: "other" });
    render(<EditActionBar form="dock" root={null} />);
    expect(screen.getByRole("button", { name: "Cut" })).toBeEnabled();
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

describe("EditActionBar on an exact range proposal", () => {
  const HINT = "Only the host or an Editor can review exact range proposals.";
  const exactProject = () => {
    const project = editFixtureProject();
    project.pending_edits[0] = {
      ...project.pending_edits[0]!,
      exact_range: { kind: "exact_range", clips: [] } as never,
    };
    return project;
  };
  const commenter = {
    projectPath: "share:tok",
    guestMode: "comment",
    shareCapabilities: [...COMMENTER_CAPABILITIES],
  };

  it("says in visible text why Approve and Reject are off for a viewer who cannot review it", () => {
    host(EDIT_SELECTIONS.suggestion, { project: exactProject(), ...commenter });
    const { container } = render(<EditActionBar form="dock" root={null} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(container.querySelector(".sys-actions-reason")).toHaveTextContent(
      HINT,
    );
  });

  it("shows the host Approve and Reject with no hint", () => {
    host(EDIT_SELECTIONS.suggestion, { project: exactProject() });
    const { container } = render(<EditActionBar form="dock" root={null} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(container.querySelector(".sys-actions-reason")).toBeNull();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("carries the hint on the floating bar too", () => {
    host(EDIT_SELECTIONS.suggestion, { project: exactProject(), ...commenter });
    render(<Floating />);
    expect(
      within(
        screen.getByRole("group", { name: "Selection actions" }),
      ).getByText(HINT),
    ).toBeVisible();
  });

  it("gives an ordinary suggestion no hint for the same viewer", () => {
    host(EDIT_SELECTIONS.suggestion, commenter);
    render(<EditActionBar form="dock" root={null} />);
    expect(screen.queryByText(HINT)).toBeNull();
  });
});

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

describe("EditActionBar against the timeline ruler", () => {
  const RULER_BOTTOM = 100;

  function rect(top: number, bottom: number) {
    return () =>
      ({
        left: 100,
        right: 400,
        top,
        bottom,
        width: 300,
        height: bottom - top,
      }) as DOMRect;
  }

  function Timeline({ selectionTop }: { selectionTop: number }) {
    const [root, setRoot] = useState<HTMLElement | null>(null);
    return (
      <div ref={setRoot}>
        <div className="timeline-scroll">
          <div
            className="timeline-ruler"
            ref={(el) => {
              if (el) el.getBoundingClientRect = rect(60, RULER_BOTTOM);
            }}
          />
          <div className="lane-row" data-track-id={MIRA}>
            <div className="lane-inner">
              <div
                className="range-overlay"
                ref={(el) => {
                  if (el)
                    el.getBoundingClientRect = rect(
                      selectionTop,
                      selectionTop + 40,
                    );
                }}
              />
            </div>
          </div>
        </div>
        <EditActionBar form="floating" root={root} />
      </div>
    );
  }

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(40);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
  });

  const BAR = 40;
  const GAP = 8;

  function barAt(selectionTop: number) {
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    render(<Timeline selectionTop={selectionTop} />);
    const bar = screen.getByLabelText("Selection actions");
    return { bar, top: Number.parseFloat(bar.style.top) };
  }

  it("hangs above a selection at the threshold barHeight + gap + margin (56 px for a 40 px bar)", () => {
    const selectionTop = RULER_BOTTOM + BAR + GAP + GAP;
    const { bar, top } = barAt(selectionTop);
    expect(top).toBe(selectionTop - GAP - BAR);
    expect(top).toBeGreaterThanOrEqual(RULER_BOTTOM);
    expect(top + BAR).toBeLessThanOrEqual(selectionTop - GAP);
    expect(bar).toBeVisible();
  });

  it("drops below a selection 1 px inside the threshold so the bar never covers the ruler", () => {
    const selectionTop = RULER_BOTTOM + BAR + GAP + GAP - 1;
    const { bar, top } = barAt(selectionTop);
    expect(top).toBe(selectionTop + BAR + GAP);
    expect(top).toBeGreaterThanOrEqual(RULER_BOTTOM);
    expect(bar).toBeVisible();
  });

  it("hides the bar when the selection is scrolled under the ruler", () => {
    const { bar } = barAt(40);
    expect(bar).not.toBeVisible();
  });
});

function Clearable({
  form,
  clear = true,
}: {
  form: "floating" | "dock";
  clear?: boolean;
}) {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  return (
    <div ref={setRoot} data-testid="stage-root">
      <div className="lane-row" data-track-id={MIRA}>
        <div className="lane-inner">
          <div className="range-overlay" />
        </div>
      </div>
      <div data-clip-id="a">
        <button type="button" className="clip-hit">
          Clip hit
        </button>
      </div>
      <EditActionBar form={form} root={root} clear={clear} />
    </div>
  );
}

const CLEARABLE: [string, unknown][] = [
  ["a clip", EDIT_SELECTIONS.clip],
  ["a seam", EDIT_SELECTIONS.seam],
  ["a track", { kind: "track", trackId: MIRA }],
  ["a range", EDIT_SELECTIONS.rangeOnAllTracks],
];

describe("EditActionBar Clear selection", () => {
  it.each(CLEARABLE)(
    "shows one Clear after the verbs for %s on the floating bar",
    (_name, selection) => {
      host(selection);
      render(<Clearable form="floating" />);
      const bar = screen.getByRole("group", { name: "Selection actions" });
      const buttons = within(bar).getAllByRole("button");
      expect(
        within(bar).getAllByRole("button", { name: "Clear selection" }),
      ).toHaveLength(1);
      expect(buttons.at(-1)).toHaveAccessibleName("Clear selection");
    },
  );

  it.each(CLEARABLE)(
    "shows one Clear after the verbs for %s on the dock",
    (_name, selection) => {
      host(selection);
      render(<Clearable form="dock" />);
      const bar = screen.getByRole("group", { name: "Edit actions" });
      const clear = within(bar).getAllByRole("button", {
        name: "Clear selection",
      });
      expect(clear).toHaveLength(1);
      expect(within(bar).getAllByRole("button").at(-1)).toBe(clear[0]);
      expect(clear[0]).toHaveTextContent("Clear");
    },
  );

  it("shows none unless the host asks for it", () => {
    host(EDIT_SELECTIONS.clip);
    render(<Clearable form="floating" clear={false} />);
    expect(
      screen.queryByRole("button", { name: "Clear selection" }),
    ).toBeNull();
  });

  it("clears the selection, the armed range and the cut hint with no document command and focuses the clip hit", async () => {
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    host(EDIT_SELECTIONS.clip, {
      rangeArmed: true,
      afterCut: { words: "gone" } as never,
    });
    render(<Clearable form="floating" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Clear selection" }),
    );
    await act(async () => {});
    const s = useDawStore.getState();
    expect(s.selection).toBeNull();
    expect(s.afterCut).toBeNull();
    expect(s.rangeArmed).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Clip hit" })).toHaveFocus();
    vi.unstubAllGlobals();
  });

  it("closes the Inspector with the selection in one press", async () => {
    host(EDIT_SELECTIONS.clip, { inspectorKey: "clip:a" });
    useDawStore.getState().setInspectorOpen(true);
    render(<Clearable form="floating" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Clear selection" }),
    );
    await act(async () => {});
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().inspectorKey).toBeNull();
  });

  it("puts focus on the bar's root for a range", async () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks, { rangeArmed: true });
    render(<Clearable form="floating" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Clear selection" }),
    );
    await act(async () => {});
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().rangeArmed).toBe(false);
    expect(screen.getByTestId("stage-root")).toHaveFocus();
  });
});

describe("EditActionBar in the Inspector dock", () => {
  it("shows Close and no Clear when the host wires onClose", async () => {
    host(EDIT_SELECTIONS.clip);
    const onClose = vi.fn();
    render(
      <EditActionBar
        form="dock"
        root={null}
        inInspector
        clear
        onClose={onClose}
      />,
    );
    const bar = screen.getByRole("group", { name: "Edit actions" });
    expect(
      within(bar).queryByRole("button", { name: "Clear selection" }),
    ).toBeNull();
    await userEvent.click(within(bar).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a clip", EDIT_SELECTIONS.clip],
    ["a range", EDIT_SELECTIONS.rangeOnAllTracks],
  ])(
    "keeps the same verbs for %s whether or not Close is up",
    (_name, selection) => {
      host(selection);
      const verbs = (withClose: boolean) => {
        const { unmount } = render(
          <EditActionBar
            form="dock"
            root={null}
            inInspector
            onClose={withClose ? () => undefined : undefined}
          />,
        );
        const labels = screen
          .getAllByRole("button")
          .filter((button) => button.getAttribute("aria-label") !== "Close")
          .map((button) => button.textContent);
        unmount();
        return labels;
      };
      expect(verbs(false)).toEqual(verbs(true));
    },
  );

  it("shows neither without onClose", () => {
    host(EDIT_SELECTIONS.clip);
    render(<EditActionBar form="dock" root={null} inInspector clear />);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Clear selection" }),
    ).toBeNull();
  });
});
