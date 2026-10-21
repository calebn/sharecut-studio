import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { moveClips } from "../../api";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import {
  beginClipPlacement,
  cancelClipPlacement,
  getClipPlacement,
} from "../../edit/clipPlacement";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { movingLikeTheQueue } from "../../test/queueDraft";
import type { ClipRow } from "../../types/project";
import { ClipPlacementControls } from "./ClipPlacementControls";

vi.mock("../../api", () => ({ moveClips: vi.fn(async () => null) }));
const clip: ClipRow = {
  id: "a",
  track_id: "host",
  source_start: 0,
  source_end: 2,
  timeline_start: 5,
  timeline_end: 7,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  source_id: null,
  source_duration_sec: null,
  recording_key: null,
};
beforeEach(() => {
  cancelClipPlacement();
  clearRegisteredCommands();
  registerDawCommands();
  vi.mocked(moveClips).mockReset();
  vi.mocked(moveClips).mockImplementation(movingLikeTheQueue(async () => null));
  useDawStore.getState().hydrate(
    "/tmp/placement-form",
    minimalProject({
      tracks: [
        sampleTrack({ id: "host", label: "Host" }),
        sampleTrack({ id: "guest", label: "Guest" }),
      ],
      clips: { tracks: { host: [clip], guest: [] }, clip_count: 1 },
    }),
  );
  useDawStore.setState({
    guestMode: null,
    shareCapabilities: null,
    toolMode: "select",
    commentMode: false,
    timelineDragging: false,
    joinMutationInFlight: false,
  });
  useDawStore
    .getState()
    .setSelection({ kind: "clip", id: "a", trackId: "host" });
});
afterEach(() => cancelClipPlacement());
it("offers native pointer buttons, track and exact start with a rendered preview", async () => {
  const user = userEvent.setup();
  const { container } = render(
    <ClipPlacementControls clipId="a" busy={false} />,
  );
  await user.click(screen.getByRole("button", { name: "Move clip" }));
  expect(screen.getByLabelText("Timeline start (seconds)")).toHaveValue(5);
  await user.click(screen.getByRole("button", { name: "Later 10 ms" }));
  expect(screen.getByLabelText("Timeline start (seconds)")).toHaveValue(5.01);
  await user.click(screen.getByRole("button", { name: "Earlier 10 ms" }));
  expect(screen.getByLabelText("Timeline start (seconds)")).toHaveValue(5);
  act(() => useDawStore.getState().setPlayheadSec(7));
  await user.click(screen.getByRole("button", { name: "Use playhead" }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Target track" }),
    "guest",
  );
  expect(screen.getByLabelText("Timeline start (seconds)")).toHaveValue(7);
  expect(getClipPlacement()).toMatchObject({
    placements: [{ clip_id: "a", timeline_start: 7, track_id: "guest" }],
  });
  await expectNoA11yViolations(container);
  await user.click(screen.getByRole("button", { name: "Apply move" }));
  expect(useDawStore.getState().project?.clips.tracks.guest[0]).toMatchObject({
    id: "a",
    timeline_start: 7,
    timeline_end: 9,
  });
});
it("disables duplicate Apply while saving and restores retry controls after refusal", async () => {
  let refuse = (_error: Error) => {};
  vi.mocked(moveClips).mockImplementationOnce(
    movingLikeTheQueue(
      () =>
        new Promise<null>((_resolve, reject) => {
          refuse = reject;
        }),
    ),
  );
  render(<ClipPlacementControls clipId="a" busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Move clip" }));
  fireEvent.click(screen.getByRole("button", { name: "Later 10 ms" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply move" }));
  expect(screen.getByRole("button", { name: "Applying move…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await act(async () => {
    await Promise.resolve();
  });
  expect(moveClips).toHaveBeenCalledTimes(1);
  await act(async () => {
    refuse(new Error("Save refused"));
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Save refused");
  expect(screen.getByRole("button", { name: "Apply move" })).toBeEnabled();
  expect(screen.getByLabelText("Timeline start (seconds)")).toHaveValue(5.01);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Apply move" }));
  });
  expect(
    useDawStore.getState().project?.clips.tracks.host[0].timeline_start,
  ).toBe(5.01);
});
it("invalid numeric input can be repaired without losing the form", async () => {
  render(<ClipPlacementControls clipId="a" busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Move clip" }));
  fireEvent.change(screen.getByLabelText("Timeline start (seconds)"), {
    target: { value: "-1" },
  });
  expect(screen.getByRole("button", { name: "Apply move" })).toBeDisabled();
  expect(screen.getByText(/Enter a timeline start/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Timeline start (seconds)"), {
    target: { value: "7.123" },
  });
  expect(screen.getByRole("button", { name: "Apply move" })).toBeEnabled();
  expect(getClipPlacement()).toMatchObject({
    placements: [{ clip_id: "a", timeline_start: 7.123, track_id: "host" }],
  });
});
it.each(["Cancel", "Escape", "blur", "unmount", "hidden"])(
  "%s cancels only the local preview",
  (action) => {
    const before = useDawStore.getState().project;
    const { unmount } = render(
      <ClipPlacementControls clipId="a" busy={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Move clip" }));
    fireEvent.click(screen.getByRole("button", { name: "Later 10 ms" }));
    expect(getClipPlacement()).toMatchObject({
      kind: "preview",
      start: "5.01",
    });
    if (action === "Cancel")
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    if (action === "Escape")
      fireEvent.keyDown(screen.getByLabelText("Timeline start (seconds)"), {
        key: "Escape",
      });
    if (action === "blur") fireEvent(window, new Event("blur"));
    if (action === "unmount") unmount();
    if (action === "hidden") {
      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      fireEvent(document, new Event("visibilitychange"));
      hidden.mockRestore();
    }
    expect(getClipPlacement()).toEqual({ kind: "idle" });
    expect(useDawStore.getState().project).toBe(before);
    expect(moveClips).not.toHaveBeenCalled();
    if (action === "Escape" || action === "Cancel")
      expect(screen.getByRole("button", { name: "Move clip" })).toHaveFocus();
  },
);
it("permission loss closes controls and disables re-entry", () => {
  useDawStore.setState({
    projectPath: "share:placement",
    guestMode: "edit",
    shareCapabilities: ["edit"],
  });
  render(<ClipPlacementControls clipId="a" busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Move clip" }));
  act(() => useDawStore.setState({ guestMode: "view", shareCapabilities: [] }));
  expect(screen.getByRole("button", { name: "Move clip" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Apply move" }),
  ).not.toBeInTheDocument();
});

it("unmount cannot cancel a replacement placement owned elsewhere", () => {
  const { unmount } = render(<ClipPlacementControls clipId="a" busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Move clip" }));
  const first = getClipPlacement();
  if (first.kind === "idle") throw new Error("placement did not start");
  act(() => {
    cancelClipPlacement(first.capture.token);
    beginClipPlacement("a");
  });
  const replacement = getClipPlacement();
  expect(replacement).toMatchObject({ kind: "preview", start: "5" });
  unmount();
  expect(getClipPlacement()).toBe(replacement);
});
