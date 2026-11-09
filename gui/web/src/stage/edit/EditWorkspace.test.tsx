import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRegisteredCommands,
  execute,
  registerCommand,
} from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { transcribeRun } from "../../test/scriptHostKit";
import { stubViewportShell } from "../../test/viewportShell";
import {
  takeAutoRoom,
  takeAutoRun,
  writeOpenIntent,
} from "../../utils/openIntent";
import { EditWorkspace } from "./EditWorkspace";

const PROJECT_PATH = "/tmp/edit-workspace/episode.sharecut";

function hydrateWithTracks() {
  useDawStore
    .getState()
    .hydrate(PROJECT_PATH, minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({
    stage: "edit",
    guestMode: null,
    scriptCollapsed: false,
    scriptFocus: false,
    editSurface: "lanes",
    openSheet: null,
  });
}

beforeEach(() => {
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  hydrateWithTracks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EditWorkspace regions", () => {
  it("dismisses View when Script focus hides its eye", async () => {
    const user = userEvent.setup();
    render(<EditWorkspace />);
    await user.click(screen.getByRole("button", { name: "View options" }));
    expect(screen.getByRole("dialog", { name: "View options" })).toBeVisible();
    await act(async () => {
      await execute("view.scriptFocus");
    });
    expect(document.querySelector(".edit-timeline-col")).toHaveAttribute(
      "hidden",
    );
    expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
    expect(document.querySelector(".edit-script")).toHaveFocus();
    await act(async () => {
      await execute("view.scriptFocus");
    });
    expect(
      screen.getByRole("button", { name: "View options" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
  });

  it.each(["loading", "empty"])(
    "returns focus to the visible %s Script region",
    async (state) => {
      if (state === "loading") useDawStore.setState({ project: null });
      else
        useDawStore
          .getState()
          .hydrate(PROJECT_PATH, minimalProject({ tracks: [] }));
      const user = userEvent.setup();
      render(<EditWorkspace />);
      await user.click(screen.getByRole("button", { name: "View options" }));
      await act(async () => {
        // The shortcut is disabled while loading; exercise the retained loading surface directly.
        if (state === "loading") useDawStore.setState({ scriptFocus: true });
        else await execute("view.scriptFocus");
      });
      expect(screen.queryByRole("dialog", { name: "View options" })).toBeNull();
      expect(document.querySelector(".edit-script")).toHaveFocus();
    },
  );

  it("hosts the timeline with its headers and the Script pane beside it", () => {
    render(<EditWorkspace />);
    expect(screen.getByRole("group", { name: "Tracks" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Script" })).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: "Resize Script" }),
    ).toBeInTheDocument();
  });

  it("has no Select, Blade or Comment tool modes anywhere on the stage", () => {
    render(<EditWorkspace />);
    expect(screen.queryByRole("group", { name: "Editing tools" })).toBeNull();
    for (const name of ["Select tool", "Blade tool", "Toggle comment mode"])
      expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("keeps the range toggle out of the track header corner and in the lane corner on touch only", () => {
    useDawStore.setState({ pointerKind: "coarse" });
    render(<EditWorkspace />);
    const headers = screen.getByRole("group", { name: "Tracks" });
    expect(
      within(headers).queryByRole("button", { name: "Select range" }),
    ).toBeNull();
    const corner = screen.getByRole("group", { name: "Timeline view" });
    expect(
      within(corner).getByRole("button", { name: "Select range" }),
    ).toBeInTheDocument();
    useDawStore.setState({ pointerKind: "fine" });
  });

  it("hides the Script pane and its divider while Script is collapsed", () => {
    useDawStore.setState({ scriptCollapsed: true });
    render(<EditWorkspace />);
    expect(screen.queryByRole("region", { name: "Script" })).toBeNull();
    expect(
      screen.queryByRole("separator", { name: "Resize Script" }),
    ).toBeNull();
  });

  it("gives the Script the whole stage in Script focus and keeps the timeline mounted", () => {
    useDawStore.setState({ scriptFocus: true });
    render(<EditWorkspace />);
    expect(screen.getByRole("region", { name: "Script" })).toBeInTheDocument();
    const column = document.querySelector<HTMLElement>(".edit-timeline-col");
    expect(column?.hidden).toBe(true);
    expect(
      screen.getByRole("group", { name: "Tracks", hidden: true }),
    ).toBeInTheDocument();
  });

  it("opens the Inspector card on Inspect, never because something is selected", () => {
    render(<EditWorkspace />);
    const card = () => screen.queryByRole("dialog", { name: "Inspector" });
    expect(card()).toBeNull();
    act(() =>
      useDawStore.getState().setSelection({ kind: "track", trackId: "host" }),
    );
    expect(card()).toBeNull();
    act(() => useDawStore.getState().setInspectorOpen(true));
    expect(card()).not.toBeNull();
    act(() =>
      useDawStore.getState().setSelection({ kind: "track", trackId: "guest" }),
    );
    expect(card()).toBeNull();
    act(() => useDawStore.getState().setInspectorOpen(true));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "track",
      trackId: "guest",
    });
  });
});

describe("EditWorkspace states", () => {
  it("shows the Import and Record Start tiles when there are no tracks", () => {
    useDawStore.getState().hydrate(PROJECT_PATH, minimalProject());
    render(<EditWorkspace />);
    expect(
      screen.getByRole("button", { name: /^Import audio/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Record/ })).toBeInTheDocument();
    expect(screen.queryByText(/Got it/)).toBeNull();
  });

  it("keeps the headers and a skeleton while the project loads", () => {
    useDawStore.setState({ project: null });
    render(<EditWorkspace />);
    expect(screen.getByRole("group", { name: "Tracks" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(
      document.querySelector("[aria-busy='true'].sys-skeleton"),
    ).not.toBeNull();
  });

  it("says the project could not load in the stage body, even with the Script collapsed", async () => {
    useDawStore.setState({ project: null, scriptCollapsed: true });
    const onRetry = vi.fn();
    render(<EditWorkspace loadFailure={{ message: "No answer.", onRetry }} />);
    const alert = screen.getByRole("alert");
    expect(
      within(alert).getByRole("heading", {
        name: "Could not load the project",
      }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(alert).getByRole("button", { name: "Try again" }),
    );
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("covers a loaded project whose transcript and history failed, with the Script collapsed", () => {
    useDawStore.setState({ scriptCollapsed: true });
    render(
      <EditWorkspace
        loadFailure={{ message: "No answer.", onRetry: vi.fn() }}
      />,
    );
    expect(
      within(screen.getByRole("alert")).getByRole("button", {
        name: "Try again",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Tracks" })).toBeNull();
  });

  it("keeps the same Try again button, focused, while the retry runs", () => {
    useDawStore.setState({ project: null });
    const failure = { message: "No answer.", onRetry: vi.fn() };
    const { rerender } = render(<EditWorkspace loadFailure={failure} />);
    const retry = screen.getByRole("button", { name: "Try again" });
    retry.focus();
    rerender(
      <EditWorkspace
        loadFailure={{ ...failure, message: "Trying again…", recovering: true }}
      />,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBe(retry);
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-busy", "true");
  });

  it("hides the plus menu from a link that cannot add audio", () => {
    useDawStore.setState({ guestMode: "comment", projectPath: "share:abc" });
    render(<EditWorkspace guestShare />);
    expect(screen.queryByRole("button", { name: "+" })).toBeNull();
  });
});

describe("EditWorkspace arrangements", () => {
  it("stacks the Script under the timeline on a narrow tablet, without a divider", () => {
    stubViewportShell("tablet", { wide: false });
    const { container } = render(<EditWorkspace />);
    expect(container.querySelector(".edit-workspace--stacked")).not.toBeNull();
    expect(screen.getByRole("region", { name: "Script" })).toBeInTheDocument();
    expect(
      screen.queryByRole("separator", { name: "Resize Script" }),
    ).toBeNull();
  });

  it("keeps the phone's two surfaces apart and carries the playhead between them", async () => {
    stubViewportShell("phone");
    useDawStore.setState({ playheadSec: 12 });
    const user = userEvent.setup();
    render(<EditWorkspace />);
    expect(screen.queryByRole("region", { name: "Script" })).toBeNull();
    expect(
      screen.getByRole("group", { name: "Timeline view" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Script" }));
    expect(useDawStore.getState().editSurface).toBe("text");
    expect(screen.queryByRole("group", { name: "Tracks" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Timeline view" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Timeline" }));
    expect(useDawStore.getState().editSurface).toBe("lanes");
    expect(useDawStore.getState().playheadSec).toBe(12);
  });

  it("keeps timeline keys on the phone's lanes and off its Script", async () => {
    stubViewportShell("phone");
    const user = userEvent.setup();
    render(<EditWorkspace />);
    const lanes = document.querySelector<HTMLElement>(".phone-edit-timeline");
    act(() => useDawStore.getState().setTimelineFocused(false));
    fireEvent.mouseDown(lanes as HTMLElement);
    expect(useDawStore.getState().timelineFocused).toBe(true);
    await user.click(screen.getByRole("button", { name: "Script" }));
    act(() => useDawStore.getState().setTimelineFocused(true));
    fireEvent.mouseDown(screen.getByRole("region", { name: "Script" }));
    expect(useDawStore.getState().timelineFocused).toBe(false);
  });

  it("opens the Mix sheet from the phone bar", async () => {
    stubViewportShell("phone");
    const user = userEvent.setup();
    render(<EditWorkspace />);
    const mix = screen.getByRole("button", { name: "Mix" });
    expect(mix.querySelector("svg.lucide-sliders-vertical")).not.toBeNull();
    await user.click(mix);
    expect(useDawStore.getState().openSheet).toBe("mix");
  });

  it("offers no Mix to a link that cannot change the mix", () => {
    stubViewportShell("phone");
    useDawStore.setState({ guestMode: "comment", projectPath: "share:abc" });
    render(<EditWorkspace guestShare />);
    expect(screen.queryByRole("button", { name: "Mix" })).toBeNull();
  });
});

describe("EditWorkspace focus regions", () => {
  it("sets timelineFocused for the timeline column and clears it for the Script pane", () => {
    render(<EditWorkspace />);
    const column = document.querySelector<HTMLElement>(".edit-timeline-col");
    const script = screen.getByRole("region", { name: "Script" });
    act(() => useDawStore.getState().setTimelineFocused(false));
    fireEvent.mouseDown(column as HTMLElement);
    expect(useDawStore.getState().timelineFocused).toBe(true);
    fireEvent.mouseDown(script);
    expect(useDawStore.getState().timelineFocused).toBe(false);
  });

  it("treats the divider and the Inspector as outside the timeline", () => {
    act(() => {
      useDawStore.getState().setSelection({ kind: "track", trackId: "host" });
      useDawStore.getState().setInspectorOpen(true);
    });
    render(<EditWorkspace />);
    for (const target of [
      screen.getByRole("separator", { name: "Resize Script" }),
      screen.getByRole("dialog", { name: "Inspector" }),
    ]) {
      act(() => useDawStore.getState().setTimelineFocused(true));
      fireEvent.mouseDown(target as HTMLElement);
      expect(useDawStore.getState().timelineFocused).toBe(false);
    }
  });
});

describe("EditWorkspace Transcribe", () => {
  const open = (tracks = [sampleTrack()]) => {
    useDawStore.getState().hydrate(PROJECT_PATH, minimalProject({ tracks }));
    useDawStore.setState({ stage: "edit", pipelineJob: null });
    sessionStorage.clear();
    render(<EditWorkspace />);
  };
  const transcribeButton = () =>
    screen.queryByRole("button", { name: "Transcribe this episode" });

  it("hands the empty Script to Prepare, which starts the run", async () => {
    open();
    await userEvent.setup().click(transcribeButton()!);
    expect(useDawStore.getState().stage).toBe("prepare");
    expect(takeAutoRun(PROJECT_PATH)).toBe(true);
    expect(takeAutoRun(PROJECT_PATH)).toBe(false);
  });

  it("stays in Edit and says so when another job holds the slot", async () => {
    open();
    useDawStore.setState({
      pipelineJob: {
        id: "bounce-1",
        kind: "bounce",
        project_path: PROJECT_PATH,
        from_step: null,
        only_step: null,
        status: "running",
        current: null,
        total: null,
        message: null,
        error: null,
        elapsed_sec: 0,
        steps: [],
      },
    });
    await userEvent.setup().click(transcribeButton()!);
    expect(useDawStore.getState().stage).toBe("edit");
    expect(takeAutoRun(PROJECT_PATH)).toBe(false);
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Another job is running. Try again when it finishes.",
    );
  });

  it("drops only the run when Prepare refuses, keeping the room request", async () => {
    open();
    writeOpenIntent(PROJECT_PATH, { autoRoom: true });
    registerCommand("stage.prepare", () => ({
      status: "disabled",
      reason: "no",
    }));
    await userEvent.setup().click(transcribeButton()!);
    expect(useDawStore.getState().stage).toBe("edit");
    expect(takeAutoRun(PROJECT_PATH)).toBe(false);
    expect(takeAutoRoom(PROJECT_PATH)).toBe(true);
  });

  it("offers no Transcribe when no track has source audio", () => {
    open([sampleTrack({ media_path: undefined })]);
    expect(screen.getByText("No transcript yet")).toBeInTheDocument();
    expect(transcribeButton()).toBeNull();
  });

  it("shows Transcribing, not the button, while a run makes the transcript", () => {
    open();
    act(() => useDawStore.setState({ pipelineJob: transcribeRun() }));
    expect(transcribeButton()).toBeNull();
    expect(screen.getByText("25%")).toBeInTheDocument();
  });
});
