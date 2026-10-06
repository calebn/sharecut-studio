import { act, render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("group", { name: "Tracks" })).toBeInTheDocument();
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

  it("has no layout control in the ruler corner", async () => {
    const project = twoTrackProject();
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TrackHeadersColumn />
      </DawProvider>,
    );
    expect(screen.queryByRole("button", { name: /Focus|Maximize/ })).toBeNull();
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

describe("TrackHeadersColumn Solo on chip", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", twoTrackProject());
    useDawStore.getState().setSoloMap({});
  });

  afterEach(() => {
    useDawStore.getState().setSoloMap({});
    clearRegisteredCommands();
  });

  it("shows Solo on · Clear solo in the ruler corner above the tracks while any track is soloed", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={twoTrackProject()}>
        <TrackHeadersColumn showSoloChip />
      </DawProvider>,
    );
    expect(
      screen.queryByRole("button", { name: "Solo on · Clear solo" }),
    ).toBeNull();

    act(() => useDawStore.getState().setSoloMap({ host: true }));
    const chip = screen.getByRole("button", { name: "Solo on · Clear solo" });
    const corner = screen
      .getByRole("group", { name: "Tracks" })
      .querySelector(":scope > .track-headers-chrome");
    expect(chip.parentElement).toBe(corner);
    expect(corner?.nextElementSibling).toHaveClass("track-header-row");
    expect(chip).toHaveAttribute(
      "title",
      "Other tracks are silent for you only. Clear solo plays every track again",
    );
    await expectNoA11yViolations(container);

    await user.tab();
    expect(chip).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(useDawStore.getState().soloTracks).toEqual({});
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Solo off. Every track plays again.",
    );
    expect(
      screen.queryByRole("button", { name: "Solo on · Clear solo" }),
    ).toBeNull();
  });

  it("leaves the phone rail corner empty: phone shows Solo on in its status row", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={twoTrackProject()}>
        <TrackHeadersColumn />
      </DawProvider>,
    );
    act(() => useDawStore.getState().setSoloMap({ host: true }));
    expect(
      screen.queryByRole("button", { name: "Solo on · Clear solo" }),
    ).toBeNull();
  });
});

describe("TrackHeadersColumn loading state", () => {
  it("exposes the labeled loading headers as a group", async () => {
    useDawStore.setState({ project: null });
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={null}>
        <TrackHeadersColumn />
      </DawProvider>,
    );

    const headers = screen.getByRole("group", { name: "Tracks" });
    expect(headers).toHaveAttribute("aria-busy", "true");
    await expectNoA11yViolations(container);
  });
});
