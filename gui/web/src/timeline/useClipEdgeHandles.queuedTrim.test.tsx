import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadBoundaryContext } from "../api/boundary";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { resetDocumentAuthority } from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { trimNeighborBounds } from "../utils/trimLimits";
import { useClipEdgeHandles } from "./useClipEdgeHandles";

const { enqueue, none } = vi.hoisted(() => {
  const none = async () => undefined;
  return {
    none,
    enqueue: async () => ({ persisted: true, hadPredecessor: false }),
  };
});
vi.mock("../services/offlineQueue/offlineStore", () => ({
  enqueueHostCommand: enqueue,
  enqueueCommand: enqueue,
  removeHostQueuedCommand: none,
  removeQueuedCommand: none,
  addHostConflict: none,
  addConflict: none,
  settleHostCommandOutcome: none,
  settleGuestCommandOutcome: none,
}));
vi.mock("../api/boundary", async (original) => ({
  ...(await original<typeof import("../api/boundary")>()),
  loadBoundaryContext: vi.fn(async () => ({ token: "boundary-token" })),
}));

const path = "/tmp/ep.json";
const saved = clipRow({
  id: "c1",
  track_id: "host",
  source_start: 2,
  source_end: 12,
  timeline_start: 0,
  timeline_end: 10,
});

const guestNext = clipRow({
  id: "g2",
  track_id: "guest",
  source_start: 10,
  source_end: 20,
  timeline_start: 10,
  timeline_end: 20,
});

/** Reads the clip the way the timeline does: from the displayed project. */
function Harness({ track = "host", index = 0 }) {
  const lane = useDawStore((s) => s.project?.clips.tracks[track]) ?? [];
  const clip = lane[index] ?? saved;
  const bounds = trimNeighborBounds(lane, index, "ripple");
  const h = useClipEdgeHandles({
    clip,
    trackId: track,
    neighborSourceLo: bounds.neighborLo,
    neighborSourceHi: bounds.neighborHi,
    zoomPxPerSec: 50,
    getTicks: () => [],
    onSelect: () => {},
  });
  return (
    <button
      onPointerDown={(e) => h.onPointerDown("trim-out", e)}
      onPointerMove={h.onPointerMove}
      onPointerUp={h.onPointerUp}
    >
      {h.trimPreview ? "previewing" : "idle"}
    </button>
  );
}

const sourceEnd = () =>
  useDawStore.getState().project?.clips.tracks.host?.[0]?.source_end;

async function dragOut(button: HTMLElement) {
  fireEvent.pointerDown(button, { pointerId: 1, clientX: 150 });
  fireEvent.pointerMove(button, { pointerId: 1, clientX: 100 });
  await act(async () =>
    fireEvent.pointerUp(button, { pointerId: 1, clientX: 100 }),
  );
}

beforeEach(() => {
  resetDocumentAuthority();
  const project = minimalProject({
    project_path: path,
    tracks: [
      sampleTrack({ id: "host" }),
      sampleTrack({ id: "guest" }),
      sampleTrack({ id: "bed", role: "music" }),
    ],
    clips: {
      tracks: {
        host: [saved],
        guest: [
          clipRow({
            id: "g1",
            track_id: "guest",
            source_start: 0,
            source_end: 10,
            timeline_start: 0,
            timeline_end: 10,
          }),
          guestNext,
        ],
        bed: [
          clipRow({
            id: "b1",
            track_id: "bed",
            source_end: 30,
            timeline_end: 30,
          }),
        ],
      },
      clip_count: 4,
    },
  });
  useDawStore.getState().hydrate(path, project);
  applyDocumentSnapshot({ server_seq: 1, project });
  useDawStore.setState({ feedbackToast: null });
});
afterEach(() => vi.unstubAllGlobals());

it("a trim that queues offline stays where the handle left it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("offline");
    }),
  );
  const button = render(<Harness />).getByRole("button");
  await dragOut(button);
  expect(button.textContent).toBe("idle");
  expect(sourceEnd()).toBe(11);
});

it("a refused trim says so and the clip returns to its saved bounds", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: "stale boundary" }), {
          status: 409,
        }),
    ),
  );
  const button = render(<Harness />).getByRole("button");
  await dragOut(button);
  expect(useDawStore.getState().feedbackToast).toMatchObject({
    tone: "error",
  });
  expect(useDawStore.getState().feedbackToast?.message).toMatch(
    /^Clip edit failed/,
  );
  expect(sourceEnd()).toBe(12);
});

const boundaryCalls = () => vi.mocked(loadBoundaryContext).mock.calls.length;

function goOffline() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("offline");
    }),
  );
}

it("a second trim of a clip whose first trim is still queued waits instead of asking the host about geometry it does not have yet", async () => {
  goOffline();
  const button = render(<Harness />).getByRole("button");
  await dragOut(button);
  expect(boundaryCalls()).toBe(1);
  await dragOut(button);
  expect(boundaryCalls()).toBe(1);
  expect(sourceEnd()).toBe(11);
  expect(useDawStore.getState().feedbackToast).toMatchObject({
    message: "This clip is waiting to send. Trim it again once it has.",
    tone: "status",
  });
});

it("a clip the queued trim's ripple moved waits too", async () => {
  goOffline();
  const view = render(<Harness />);
  await dragOut(view.getByRole("button"));
  view.unmount();
  const guestLane = () => useDawStore.getState().project?.clips.tracks.guest;
  expect(guestLane()?.[1]?.timeline_start).toBe(9);
  const guest = render(<Harness track="guest" index={1} />).getByRole("button");
  await dragOut(guest);
  expect(boundaryCalls()).toBe(1);
  expect(guestLane()?.[1]?.timeline_end).toBe(19);
  expect(useDawStore.getState().feedbackToast?.message).toMatch(
    /waiting to send/,
  );
});

it("a track the queued trim does not ripple trims at once", async () => {
  goOffline();
  const first = render(<Harness />);
  await dragOut(first.getByRole("button"));
  first.unmount();
  const guest = render(<Harness track="bed" index={0} />).getByRole("button");
  await dragOut(guest);
  expect(boundaryCalls()).toBe(2);
});

it("trims again once the host holds the first trim", async () => {
  goOffline();
  const button = render(<Harness />).getByRole("button");
  await dragOut(button);
  const project = useDawStore.getState().project!;
  applyDocumentSnapshot({ server_seq: 2, project });
  await dragOut(button);
  expect(boundaryCalls()).toBe(2);
  expect(sourceEnd()).toBe(10);
});
