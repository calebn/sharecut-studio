import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { moveClips } from "../../api";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import {
  cancelClipPlacement,
  getClipPlacement,
} from "../../edit/clipPlacement";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { movingLikeTheQueue } from "../../test/queueDraft";
import type { ClipRow } from "../../types/project";
import { ClipStartField, ClipTrackRow } from "./clipPlacementFields";

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
const tracks = [
  { id: "host", label: "Host" },
  { id: "guest", label: "Guest" },
];
const start = () => screen.getByRole("spinbutton", { name: "Start" });

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
    timelineDragging: false,
    joinMutationInFlight: false,
  });
  useDawStore
    .getState()
    .setSelection({ kind: "clip", id: "a", trackId: "host" });
});
afterEach(() => cancelClipPlacement());

it("moves the clip by its Start field: a drag previews, a release saves once, and there is no Apply", async () => {
  const { container } = render(<ClipStartField clip={clip} disabled={false} />);
  expect(start()).toHaveAttribute("aria-valuenow", "5");
  fireEvent.pointerDown(start(), { clientX: 100, pointerId: 1, button: 0 });
  fireEvent.pointerMove(start(), { clientX: 110, pointerId: 1 });
  fireEvent.pointerMove(start(), { clientX: 150, pointerId: 1 });
  expect(getClipPlacement()).toMatchObject({
    kind: "preview",
    placements: [{ clip_id: "a", track_id: "host" }],
  });
  expect(moveClips).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.pointerUp(start(), { pointerId: 1 });
  });
  expect(moveClips).toHaveBeenCalledTimes(1);
  expect(
    useDawStore.getState().project?.clips.tracks.host[0].timeline_start,
  ).toBeCloseTo(5.4, 5);
  expect(screen.queryByRole("button")).toBeNull();
  expect(container.querySelector('input[type="number"]')).toBeNull();
  await expectNoA11yViolations(container);
});

it("Escape in the scrub drops the preview and saves nothing", () => {
  render(<ClipStartField clip={clip} disabled={false} />);
  fireEvent.pointerDown(start(), { clientX: 100, pointerId: 1, button: 0 });
  fireEvent.pointerMove(start(), { clientX: 110, pointerId: 1 });
  fireEvent.pointerMove(start(), { clientX: 150, pointerId: 1 });
  expect(getClipPlacement().kind).toBe("preview");
  fireEvent.keyDown(start(), { key: "Escape" });
  expect(getClipPlacement()).toEqual({ kind: "idle" });
  expect(moveClips).not.toHaveBeenCalled();
});

it.each(["blur", "hidden", "unmount"])(
  "%s ends only the local preview",
  (action) => {
    const { unmount } = render(<ClipStartField clip={clip} disabled={false} />);
    fireEvent.pointerDown(start(), { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(start(), { clientX: 110, pointerId: 1 });
    fireEvent.pointerMove(start(), { clientX: 150, pointerId: 1 });
    expect(getClipPlacement().kind).toBe("preview");
    if (action === "blur") fireEvent(window, new Event("blur"));
    if (action === "unmount") unmount();
    if (action === "hidden") {
      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      fireEvent(document, new Event("visibilitychange"));
      hidden.mockRestore();
    }
    expect(getClipPlacement()).toEqual({ kind: "idle" });
    expect(moveClips).not.toHaveBeenCalled();
  },
);

it("a track toggle moves the clip there at the same time", async () => {
  const user = userEvent.setup();
  render(<ClipTrackRow clip={clip} tracks={tracks} disabled={false} />);
  expect(screen.getByRole("button", { name: "Host" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await user.click(screen.getByRole("button", { name: "Guest" }));
  expect(useDawStore.getState().project?.clips.tracks.guest[0]).toMatchObject({
    id: "a",
    timeline_start: 5,
    timeline_end: 7,
  });
});

it("permission loss makes the field read-only and the toggles inert", async () => {
  useDawStore.setState({
    projectPath: "share:placement",
    guestMode: "view",
    shareCapabilities: [],
  });
  const user = userEvent.setup();
  render(
    <>
      <ClipStartField clip={clip} disabled={false} />
      <ClipTrackRow clip={clip} tracks={tracks} disabled={false} />
    </>,
  );
  expect(start()).toHaveAttribute("aria-readonly", "true");
  await user.click(screen.getByRole("button", { name: "Guest" }));
  expect(moveClips).not.toHaveBeenCalled();
});
