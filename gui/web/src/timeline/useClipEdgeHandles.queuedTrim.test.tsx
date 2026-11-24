import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

/** Reads the clip the way the timeline does: from the displayed project. */
function Harness() {
  const lane = useDawStore((s) => s.project?.clips.tracks.host) ?? [];
  const clip = lane[0] ?? saved;
  const bounds = trimNeighborBounds(lane, 0, "ripple");
  const h = useClipEdgeHandles({
    clip,
    trackId: "host",
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
    tracks: [sampleTrack({ id: "host" })],
    clips: { tracks: { host: [saved] }, clip_count: 1 },
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
