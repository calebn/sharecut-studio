import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { EditWorkspace } from "./EditWorkspace";

const PROJECT_PATH = "/tmp/edit-workspace/episode.project.json";

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
  it("hosts the timeline with its headers and the Script pane beside it", () => {
    render(<EditWorkspace />);
    expect(screen.getByRole("group", { name: "Tracks" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Script" })).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: "Resize Script" }),
    ).toBeInTheDocument();
  });

  it("puts the tool strip in the timeline corner above the track headers", () => {
    render(<EditWorkspace />);
    const headers = screen.getByRole("group", { name: "Tracks" });
    const strip = within(headers).getByRole("group", { name: "Editing tools" });
    expect(strip.closest(".track-headers-chrome")).not.toBeNull();
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

  it("shows the Inspector column only for a selection that has one", () => {
    const { container } = render(<EditWorkspace />);
    expect(container.querySelector(".edit-inspector")).toBeNull();
    act(() =>
      useDawStore.getState().setSelection({ kind: "track", trackId: "host" }),
    );
    expect(container.querySelector(".edit-inspector")).not.toBeNull();
  });
});

describe("EditWorkspace states", () => {
  it("shows the empty-session drop target when there are no tracks", () => {
    useDawStore.getState().hydrate(PROJECT_PATH, minimalProject());
    render(<EditWorkspace />);
    expect(
      screen.getByRole("button", { name: /Drop audio files here/ }),
    ).toBeInTheDocument();
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

  it("says the Script could not load and retries from the pane", async () => {
    const onRetry = vi.fn();
    render(<EditWorkspace loadFailure={{ message: "No answer.", onRetry }} />);
    const pane = screen.getByRole("region", { name: "Script" });
    expect(within(pane).getByText("Script could not load")).toBeInTheDocument();
    await userEvent.click(within(pane).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
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
      screen.getByRole("group", { name: "Editing tools" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Script" }));
    expect(useDawStore.getState().editSurface).toBe("text");
    expect(screen.queryByRole("group", { name: "Tracks" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Editing tools" })).toBeNull();
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
    await user.click(screen.getByRole("button", { name: "Mix" }));
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
    act(() =>
      useDawStore.getState().setSelection({ kind: "track", trackId: "host" }),
    );
    const { container } = render(<EditWorkspace />);
    for (const target of [
      screen.getByRole("separator", { name: "Resize Script" }),
      container.querySelector<HTMLElement>(".edit-inspector"),
    ]) {
      act(() => useDawStore.getState().setTimelineFocused(true));
      fireEvent.mouseDown(target as HTMLElement);
      expect(useDawStore.getState().timelineFocused).toBe(false);
    }
  });
});
