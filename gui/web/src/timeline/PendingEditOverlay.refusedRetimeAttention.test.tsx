import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { resetDocumentAuthority } from "../document/authorityState";
import { loadHostConflicts } from "../services/offlineQueue/offlineStore";
import { OfflineAttentionAnnouncer } from "../stage/frame/OfflineAttentionAnnouncer";
import { StatusLive } from "../stage/frame/StatusLive";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, pendingEditView } from "../test/fixtures";
import { PendingEditOverlay } from "./PendingEditOverlay";

// Only the browser's key-value storage is replaced (in memory); the offline
// store, the command queue and the Needs-attention announcer are the real ones.
const kv = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../state/idbKv", () => ({
  STORE: "kv",
  openDb: async () => undefined,
  idbGet: async (key: string) => structuredClone(kv.get(key)),
  idbSet: async (key: string, value: unknown) => {
    kv.set(key, structuredClone(value));
  },
  idbDelete: async (key: string) => {
    kv.delete(key);
  },
  updateStoredList: async (
    key: string,
    parse: (value: unknown) => unknown[],
    update: (items: never[]) => { items: unknown[]; result: unknown },
  ) => {
    const next = update(parse(structuredClone(kv.get(key))) as never[]);
    kv.set(key, structuredClone(parse(next.items)));
    return next.result;
  },
}));
vi.mock("../hooks/useWaveformSnapTicks", () => ({
  useWaveformSnapTicks: () => ({
    ticks: [],
    resolveTicks: async () => [],
  }),
}));

const path = "/tmp/p.json";
const SENTENCE =
  "That edit's end was not saved, so it is back where it was. Move the edge again or pick a different range.";

function refuse(status: number, detail: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ detail }), { status })),
  );
}

function mountAll() {
  const edit = pendingEditView({
    id: "cut_1",
    track_id: "host",
    track_ids: ["host"],
    reason: "guest:suggest",
    source_start: 2,
    source_end: 6,
    source_start_timeline: 2,
    source_end_timeline: 6,
    timeline_start: 2,
    timeline_end: 6,
    timeline_spans: [{ start: 2, end: 6 }],
  });
  const project = minimalProject({
    project_path: path,
    pending_edits: [edit],
    clips: {
      tracks: {
        host: [
          clipRow({
            id: "c1",
            track_id: "host",
            source_end: 30,
            timeline_end: 30,
          }),
        ],
      },
    },
  } as never);
  useDawStore.getState().hydrate(path, project);
  applyDocumentSnapshot({
    server_seq: 1,
    project: useDawStore.getState().project as never,
  });
  useDawStore.setState({
    stage: "edit",
    statusAnnouncement: "",
    feedbackToast: null,
    selection: { kind: "pending", id: edit.id, trackId: "host" },
  });
  return render(
    <>
      <OfflineAttentionAnnouncer />
      <StatusLive />
      <PendingEditOverlay
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId={edit.id}
        onSelect={vi.fn()}
      />
    </>,
  );
}

describe("a refused edge-drag save with the real offline queue (#4373)", () => {
  beforeEach(() => {
    kv.clear();
    // The real store only admits a command when IndexedDB exists; kv above backs it.
    vi.stubGlobal("indexedDB", {});
    HTMLElement.prototype.setPointerCapture = vi.fn();
    resetDocumentAuthority();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps its sentence in the status line and adds no Needs attention row", async () => {
    refuse(409, "Edit changed");
    mountAll();
    // Let the announcer's first read finish before the drag.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const handle = document.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 7 });
    fireEvent.pointerMove(handle, { clientX: 130, pointerId: 7 });
    fireEvent.pointerUp(handle, { clientX: 130, pointerId: 7 });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() =>
      expect(useDawStore.getState().pendingRetimeInFlight).toBeNull(),
    );
    expect(screen.getByRole("status").textContent).toBe(SENTENCE);
    // Past the attention poll interval (2 s): nothing may replace the sentence.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2300));
    });
    expect(await loadHostConflicts(path)).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe(SENTENCE);
    expect(useDawStore.getState().statusAnnouncement).toBe(SENTENCE);
  });
});
