import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDawKeymapListener } from "../keymap/listener";
import { TransportBar } from "../layout/TransportBar";
import { useDawStore } from "../state/dawStore";
import { setChrome } from "../test/chrome";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { executePointerCommand } from "./pointer";
import { registerDawCommands } from "./register";

function TransportHost() {
  useDawKeymapListener();
  return (
    <>
      <TransportBar />
      <div tabIndex={-1} data-testid="timeline">
        Timeline
      </div>
    </>
  );
}

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate("/tmp/transport-availability", minimalProject());
  setChrome({
    commandPaletteOpen: false,
    bounceDialogOpen: false,
    shareDialogOpen: false,
  });
  useDawStore.setState({
    isPlaying: false,
    playStartSec: null,
    playheadSec: 0,
    timelineFocused: true,
    activeTab: "comments",
    followingClientId: null,
  });
});

afterEach(() => {
  clearRegisteredCommands();
});

const readyProject = () => minimalProject({ tracks: [sampleTrack()] });

for (const id of ["transport.togglePlay", "transport.stop"]) {
  describe(id, () => {
    for (const [state, project, reason] of [
      ["loading", null, "Loading project…"],
      ["empty", minimalProject(), "Import audio to play."],
    ] as const) {
      it(`rejects a ${state} project through command and pointer dispatch, then recovers`, async () => {
        useDawStore.setState({ project, followingClientId: "leader" });
        expect(await execute(id)).toEqual({ status: "disabled", reason });
        useDawStore.setState({ timelineFocused: false });
        expect(await execute(id, {}, { skipWhen: true })).toEqual({
          status: "disabled",
          reason,
        });
        expect(await executePointerCommand(id)).toEqual({
          status: "disabled",
          reason,
        });
        expect(useDawStore.getState().isPlaying).toBe(false);
        expect(useDawStore.getState().playStartSec).toBeNull();
        expect(useDawStore.getState().followingClientId).toBe("leader");
        useDawStore.getState().setProject(readyProject());
        expect(await executePointerCommand(id)).toEqual({ status: "ok" });
        expect(useDawStore.getState().isPlaying).toBe(
          id === "transport.togglePlay",
        );
      });
    }
  });
}

it("keeps loading and empty Space inert, then Space and K control imported tracks", async () => {
  useDawStore.setState({ project: null });
  render(<TransportHost />);
  const timeline = screen.getByTestId("timeline");
  timeline.focus();
  await act(async () => {
    fireEvent.keyDown(timeline, { key: " ", code: "Space" });
  });
  expect(useDawStore.getState().isPlaying).toBe(false);
  expect(
    screen.getByRole("button", { name: "Play" }),
  ).toHaveAccessibleDescription("Loading project…");
  act(() => useDawStore.getState().setProject(minimalProject()));
  await act(async () => {
    fireEvent.keyDown(timeline, { key: " ", code: "Space" });
  });
  expect(useDawStore.getState().isPlaying).toBe(false);
  expect(useDawStore.getState().playStartSec).toBeNull();
  expect(
    screen.getByRole("button", { name: "Play" }),
  ).toHaveAccessibleDescription("Import audio to play.");

  act(() => {
    useDawStore.getState().setProject(readyProject());
    useDawStore.getState().setPlayheadSec(12);
  });
  await act(async () => {
    fireEvent.keyDown(timeline, { key: " ", code: "Space" });
  });
  expect(useDawStore.getState().isPlaying).toBe(true);
  act(() => useDawStore.getState().setPlayheadSec(25));
  await act(async () => {
    fireEvent.keyDown(timeline, { key: "k", code: "KeyK" });
  });
  expect(useDawStore.getState().isPlaying).toBe(false);
  expect(useDawStore.getState().playheadSec).toBe(12);
});

it("keeps focused Play inert while loading and empty, then activates without editor focus", async () => {
  const user = userEvent.setup();
  useDawStore.setState({ project: null, timelineFocused: false });
  render(<TransportHost />);
  const play = screen.getByRole("button", { name: "Play" });
  play.focus();
  expect(play).toHaveAccessibleDescription("Loading project…");
  await user.keyboard(" ");
  expect(useDawStore.getState().isPlaying).toBe(false);
  act(() => useDawStore.getState().setProject(minimalProject()));
  expect(play).toHaveFocus();
  expect(play).toHaveAccessibleDescription("Import audio to play.");
  await user.click(play);
  expect(useDawStore.getState().isPlaying).toBe(false);
  act(() => {
    useDawStore.getState().setProject(readyProject());
    useDawStore.getState().setPlayheadSec(8);
  });
  expect(play).toHaveFocus();
  await user.keyboard(" ");
  expect(useDawStore.getState().isPlaying).toBe(true);
  act(() => useDawStore.getState().setPlayheadSec(20));
  await user.click(screen.getByRole("button", { name: "Stop playback" }));
  expect(useDawStore.getState().isPlaying).toBe(false);
  expect(useDawStore.getState().playheadSec).toBe(8);
});

it("allows a muted zero-duration track without media heuristics", async () => {
  useDawStore.getState().setProject(
    minimalProject({
      timeline_duration_sec: 0,
      tracks: [sampleTrack({ duration_sec: 0, muted: true })],
    }),
  );
  expect(await execute("transport.togglePlay")).toEqual({ status: "ok" });
  expect(useDawStore.getState().isPlaying).toBe(true);
  expect(await execute("transport.stop")).toEqual({ status: "ok" });
  expect(useDawStore.getState().isPlaying).toBe(false);
});

it("keeps Pause and Stop reachable when the last track disappears during playback", async () => {
  const user = userEvent.setup();
  useDawStore.getState().setProject(readyProject());
  useDawStore.getState().setPlayheadSec(10);
  await execute("transport.togglePlay");
  useDawStore.getState().setPlayheadSec(25);
  render(<TransportHost />);
  act(() => useDawStore.getState().setProject(minimalProject()));
  const pause = screen.getByRole("button", { name: "Pause" });
  expect(pause).not.toHaveAttribute("aria-disabled");
  expect(
    screen.getByRole("button", { name: "Stop playback" }),
  ).not.toHaveAttribute("aria-disabled");
  await user.click(pause);
  expect(useDawStore.getState().isPlaying).toBe(false);
  expect(useDawStore.getState().playheadSec).toBe(25);
  expect(
    screen.getByRole("button", { name: "Play" }),
  ).toHaveAccessibleDescription("Import audio to play.");
  expect(await execute("transport.togglePlay", {}, { skipWhen: true })).toEqual(
    {
      status: "disabled",
      reason: "Import audio to play.",
    },
  );
  const stop = screen.getByRole("button", { name: "Stop playback" });
  expect(stop).not.toHaveAttribute("aria-disabled");
  await user.click(stop);
  expect(useDawStore.getState().isPlaying).toBe(false);
  expect(useDawStore.getState().playheadSec).toBe(10);
  expect(useDawStore.getState().playStartSec).toBeNull();
  expect(stop).toHaveAccessibleDescription("Import audio to play.");
});

it("lets K finish a paused transport after last-track removal and clamps its return", async () => {
  useDawStore.getState().setProject(readyProject());
  useDawStore.getState().setPlayheadSec(30);
  await execute("transport.togglePlay");
  useDawStore.getState().setPlayheadSec(40);
  await execute("transport.togglePlay");
  useDawStore
    .getState()
    .setProject(minimalProject({ timeline_duration_sec: 20 }));
  render(<TransportHost />);
  await act(async () => {
    fireEvent.keyDown(screen.getByTestId("timeline"), {
      key: "k",
      code: "KeyK",
    });
  });
  expect(useDawStore.getState().isPlaying).toBe(false);
  expect(useDawStore.getState().playheadSec).toBe(20);
  expect(useDawStore.getState().playStartSec).toBeNull();
});

it("preserves active Stop after same-project hydration removes the final track", async () => {
  const state = () => useDawStore.getState();
  state().setProject(readyProject());
  state().setPlayheadSec(0);
  expect(await execute("transport.togglePlay")).toEqual({ status: "ok" });
  state().setPlayheadSec(15);
  state().hydrate("/tmp/transport-availability", minimalProject());
  expect(state().isPlaying).toBe(true);
  expect(state().playStartSec).toBe(0);
  expect(await executePointerCommand("transport.stop")).toEqual({
    status: "ok",
  });
  expect(state().isPlaying).toBe(false);
  expect(state().playheadSec).toBe(0);
  expect(state().playStartSec).toBeNull();
  expect(await executePointerCommand("transport.stop")).toEqual({
    status: "disabled",
    reason: "Import audio to play.",
  });
});

it("preserves the existing no-project refusal even with retained transport state", async () => {
  useDawStore.setState({
    project: null,
    isPlaying: true,
    playStartSec: 0,
    playheadSec: 12,
  });
  for (const id of ["transport.togglePlay", "transport.stop"]) {
    expect(await executePointerCommand(id)).toEqual({
      status: "disabled",
      reason: "Loading project…",
    });
  }
  expect(useDawStore.getState().isPlaying).toBe(true);
  expect(useDawStore.getState().playStartSec).toBe(0);
  expect(useDawStore.getState().playheadSec).toBe(12);
});
