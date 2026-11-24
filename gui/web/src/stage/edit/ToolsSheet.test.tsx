import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  EDIT_SELECTIONS,
  editFixtureProject,
} from "../../test/actionBarFixtures";
import { clipRow, minimalProject, sampleTrack } from "../../test/fixtures";
import { ToolsButton } from "./ToolsButton";
import { ToolsSheet } from "./ToolsSheet";

const viewport = vi.hoisted(() => ({ shell: "phone" as string }));
vi.mock("../../hooks/useViewportClass", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useViewportClass")>()),
  useViewportClass: () => viewport.shell,
}));

beforeEach(() => {
  viewport.shell = "phone";
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().hydrate(
    "/tmp/tools/p.json",
    minimalProject({
      tracks: [sampleTrack()],
      clips: {
        tracks: {
          [sampleTrack().id]: [
            clipRow({ track_id: sampleTrack().id, timeline_end: 5 }),
          ],
        },
        clip_count: 1,
      },
    }),
  );
  useDawStore.setState({
    guestMode: null,
    rangeArmed: false,
    editSurface: "lanes",
    openSheet: null,
    scriptHeaderClear: false,
  });
});

describe("ToolsButton", () => {
  it("opens the Tools sheet", async () => {
    const user = userEvent.setup();
    render(<ToolsButton />);
    const button = screen.getByRole("button", { name: "Tools, Timeline" });
    await user.click(button);
    expect(useDawStore.getState().openSheet).toBe("tools");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("names the Edit surface in use on a phone, and just Tools elsewhere", () => {
    useDawStore.setState({ editSurface: "text" });
    const { unmount } = render(<ToolsButton />);
    expect(
      screen.getByRole("button", { name: "Tools, Script" }),
    ).toBeInTheDocument();
    unmount();
    viewport.shell = "tablet";
    render(<ToolsButton />);
    expect(screen.getByRole("button", { name: "Tools" })).toBeInTheDocument();
  });
});

describe("ToolsSheet", () => {
  it("ends the Action bar with Clear selection on the lanes surface, and closes with it", async () => {
    const user = userEvent.setup();
    useDawStore.setState({
      selection: EDIT_SELECTIONS.clip as never,
      openSheet: "tools",
    });
    render(<ToolsSheet />);
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().openSheet).toBeNull();
  });

  it("leaves Clear to the Script header on the Script surface while the header shows it", () => {
    useDawStore.setState({
      selection: EDIT_SELECTIONS.clip as never,
      editSurface: "text",
      scriptHeaderClear: true,
    });
    render(<ToolsSheet />);
    expect(
      screen.queryByRole("button", { name: "Clear selection" }),
    ).toBeNull();
  });

  it("ends the bar with Clear for a clip selected on the Script surface, which the header does not clear", () => {
    useDawStore.setState({
      selection: EDIT_SELECTIONS.clip as never,
      editSurface: "text",
      scriptHeaderClear: false,
    });
    render(<ToolsSheet />);
    expect(
      screen.getByRole("button", { name: "Clear selection" }),
    ).toBeInTheDocument();
  });

  it("holds the surface switch, the corner and Mix, and is axe-clean", async () => {
    const user = userEvent.setup();
    const { container } = render(<ToolsSheet />);
    expect(
      screen.getByRole("group", { name: "Edit surface" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Timeline view" }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "Script" }));
    expect(useDawStore.getState().editSurface).toBe("text");
    const mix = screen.getByRole("button", { name: "Mix" });
    expect(mix.querySelector("svg.lucide-sliders-vertical")).not.toBeNull();
    await user.click(mix);
    expect(useDawStore.getState().openSheet).toBe("mix");
  });

  it("holds the corner a short frame takes off the lanes", async () => {
    const user = userEvent.setup();
    render(<ToolsSheet />);
    const corner = screen.getByRole("group", { name: "Timeline view" });
    expect(corner).toBeInTheDocument();
    // The phone has no side-by-side Script pane, so no Script toggle.
    expect(screen.queryByRole("button", { name: /Script pane/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "View options" }));
    expect(
      screen.getByRole("dialog", { name: "View options" }),
    ).toBeInTheDocument();
  });

  it("closes after a verb runs, not when More opens its menu", async () => {
    const user = userEvent.setup();
    useDawStore.setState({
      project: editFixtureProject(),
      projectPath: "/tmp/tools/p.json",
      stage: "edit",
      selection: EDIT_SELECTIONS.rangeOnAllTracks as never,
      openSheet: "tools",
    });
    render(<ToolsSheet />);
    await user.click(screen.getByRole("button", { name: /^More/ }));
    expect(useDawStore.getState().openSheet).toBe("tools");
    expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /^Hear/ }));
    expect(useDawStore.getState().openSheet).toBeNull();
  });

  it("labels Record Re-record on a replaceable range and drops it past the timeline", async () => {
    const user = userEvent.setup();
    const project = editFixtureProject();
    useDawStore.setState({
      project,
      projectPath: "/tmp/tools/p.json",
      stage: "edit",
      selection: EDIT_SELECTIONS.rangeOnAllTracks as never,
      openSheet: "tools",
    });
    const { unmount } = render(<ToolsSheet />);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: /^Re-record/ })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: /^Record/ })).toBeNull();
    unmount();
    useDawStore.setState({
      project: {
        ...project,
        timeline_duration_sec: 1.5,
      },
    });
    render(<ToolsSheet />);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: /record/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /record/i })).toBeNull();
  });

  it("on a tablet holds the corner with the Script toggle and no surface switch", () => {
    viewport.shell = "tablet";
    render(<ToolsSheet />);
    expect(
      screen.getByRole("group", { name: "Timeline view" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Edit surface" })).toBeNull();
  });

  it("holds the touch range toggle with the corner a short frame takes off the lanes", async () => {
    const user = userEvent.setup();
    useDawStore.setState({ pointerKind: "coarse", selection: null });
    render(<ToolsSheet />);
    await user.click(screen.getByRole("button", { name: "Select range" }));
    expect(useDawStore.getState().rangeArmed).toBe(true);
  });
});
