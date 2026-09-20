import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands, execute } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { TrackHeadersColumn } from "./TrackHeadersColumn";

function twoTrackProject() {
  return minimalProject({
    tracks: [
      {
        id: "host",
        label: "Host",
        role: "dialogue",
        speaker: null,
        gain_db: 0,
        muted: false,
        duration_sec: 60,
        fx_count: 0,
        stem_is_fresh: true,
      },
      {
        id: "guest",
        label: "Guest",
        role: "dialogue",
        speaker: null,
        gain_db: 0,
        muted: false,
        duration_sec: 60,
        fx_count: 0,
        stem_is_fresh: true,
      },
    ],
  });
}

describe("track.selectAll / track.deselectAll", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", twoTrackProject());
    useDawStore.setState({
      timelineFocused: true,
      selectedTrackIds: ["host"],
      selection: { kind: "track", trackId: "host" },
    });
  });

  afterEach(() => {
    clearRegisteredCommands();
  });

  it("selects every project track id", async () => {
    const r = await execute("track.selectAll");
    expect(r.status).toBe("ok");
    expect(useDawStore.getState().selectedTrackIds).toEqual(["host", "guest"]);
  });

  it("clears targeting and track inspector selection", async () => {
    const r = await execute("track.deselectAll");
    expect(r.status).toBe("ok");
    expect(useDawStore.getState().selectedTrackIds).toEqual([]);
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("does not clear clip inspector selection on deselect", async () => {
    useDawStore.setState({
      selection: { kind: "clip", id: "c1", trackId: "host" },
    });
    await execute("track.deselectAll");
    expect(useDawStore.getState().selection).toEqual({
      kind: "clip",
      id: "c1",
      trackId: "host",
    });
  });
});

describe("TrackHeadersColumn deselect well", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", twoTrackProject());
    useDawStore.setState({
      selectedTrackIds: ["host", "guest"],
      selection: { kind: "track", trackId: "host" },
    });
  });

  afterEach(() => {
    clearRegisteredCommands();
  });

  it("deselects all tracks when the leftover header well is clicked", async () => {
    const user = userEvent.setup();
    const project = twoTrackProject();
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TrackHeadersColumn />
      </DawProvider>,
    );
    useDawStore.setState({
      selectedTrackIds: ["host", "guest"],
      selection: { kind: "track", trackId: "host" },
    });
    const wells = screen.getAllByRole("button", {
      name: "Deselect all tracks",
    });
    expect(wells).toHaveLength(1);
    await user.click(wells[wells.length - 1]);
    expect(useDawStore.getState().selectedTrackIds).toEqual([]);
    await expectNoA11yViolations(container);
  });

  it("deselects all tracks when leftover header chrome is clicked", async () => {
    const user = userEvent.setup();
    const project = twoTrackProject();
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TrackHeadersColumn />
      </DawProvider>,
    );
    useDawStore.setState({
      selectedTrackIds: ["host", "guest"],
      selection: { kind: "track", trackId: "host" },
    });
    const overlay = container.querySelector(".track-headers-deselect");
    expect(overlay?.tagName).toBe("DIV");
    expect(overlay).toHaveAttribute("role", "presentation");
    expect(overlay).not.toHaveAttribute("aria-hidden");
    expect(overlay).not.toHaveAttribute("title");
    await user.click(overlay as HTMLElement);
    expect(useDawStore.getState().selectedTrackIds).toEqual([]);
  });

  it("keeps FocusToggle clickable over leftover chrome", async () => {
    const user = userEvent.setup();
    const project = twoTrackProject();
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TrackHeadersColumn showFocusToggle />
      </DawProvider>,
    );
    useDawStore.setState({
      selectedTrackIds: ["host", "guest"],
      selection: { kind: "track", trackId: "host" },
      focusMode: "default",
    });
    const focus = screen.getByRole("button", { name: "Focus" });
    await user.click(focus);
    expect(useDawStore.getState().focusMode).toBe("timeline");
    expect(useDawStore.getState().selectedTrackIds).toEqual(["host", "guest"]);
    expect(
      screen.getAllByRole("button", { name: "Deselect all tracks" }),
    ).toHaveLength(1);
    await expectNoA11yViolations(container);
  });

  it("keeps exclusive select when a track header is clicked", async () => {
    const user = userEvent.setup();
    const project = twoTrackProject();
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TrackHeadersColumn />
      </DawProvider>,
    );
    await user.click(
      screen.getByRole("button", { name: /Open track details, Guest/i }),
    );
    expect(useDawStore.getState().selectedTrackIds).toEqual(["guest"]);
  });
});
