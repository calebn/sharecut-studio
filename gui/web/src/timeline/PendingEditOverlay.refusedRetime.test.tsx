import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { resetDocumentAuthority } from "../document/authorityState";
import { hasDocumentDrafts } from "../document/pendingDrafts";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, pendingEditView } from "../test/fixtures";
import type { PendingEditView } from "../types/project";
import { PendingEditOverlay } from "./PendingEditOverlay";

const { enqueue, remove, settle } = vi.hoisted(() => {
  const remove = async () => undefined;
  const enqueue = async () => ({ persisted: true, hadPredecessor: false });
  return { enqueue, remove, settle: async () => undefined };
});
vi.mock("../services/offlineQueue/offlineStore", () => ({
  enqueueHostCommand: enqueue,
  enqueueCommand: enqueue,
  removeHostQueuedCommand: remove,
  removeQueuedCommand: remove,
  addHostConflict: remove,
  addConflict: remove,
  settleHostCommandOutcome: settle,
  settleGuestCommandOutcome: settle,
}));
vi.mock("../hooks/useWaveformSnapTicks", () => ({
  useWaveformSnapTicks: vi.fn(() => ({
    ticks: [],
    resolveTicks: vi.fn(async () => []),
  })),
}));

const path = "/tmp/p.json";
const SAVED_START = 2;
const SAVED_END = 6;
const TEXT_PER_EDGE = (edge: string) =>
  `That edit's ${edge} was not saved, so it is back where it was. Move the edge again or pick a different range.`;
const GONE = "That suggestion is gone, so nothing was saved.";

type Refusal = {
  label: string;
  status: number;
  code: string | null;
  detail: string;
  sentence: (edge: string) => string;
};

const REFUSALS: Refusal[] = [
  {
    label: "409",
    status: 409,
    code: null,
    detail: "Edit changed",
    sentence: TEXT_PER_EDGE,
  },
  {
    label: "400",
    status: 400,
    code: null,
    detail: "Range overlaps an exact-range edit",
    sentence: TEXT_PER_EDGE,
  },
  {
    label: "404 pending_edit_not_found",
    status: 404,
    code: "pending_edit_not_found",
    detail: "pending edit not found: cut_1",
    sentence: () => GONE,
  },
];

const KINDS: [string, Partial<PendingEditView>][] = [
  ["remove", { type: "remove", suggested_action: "cut" }],
  ["mute", { type: "mute", suggested_action: "lower" }],
  ["suggested shorten", { type: "remove", suggested_action: "shorten" }],
  ["suggested lower", { type: "remove", suggested_action: "lower" }],
  ["suggested leave", { type: "remove", suggested_action: "leave" }],
  ["no suggested action", { type: "remove", suggested_action: null }],
];

function editWith(overrides: Partial<PendingEditView>): PendingEditView {
  return pendingEditView({
    id: "cut_1",
    track_id: "host",
    track_ids: ["host"],
    reason: "guest:suggest",
    source_start: SAVED_START,
    source_end: SAVED_END,
    source_start_timeline: SAVED_START,
    source_end_timeline: SAVED_END,
    timeline_start: SAVED_START,
    timeline_end: SAVED_END,
    timeline_spans: [{ start: SAVED_START, end: SAVED_END }],
    ...overrides,
  });
}

function refuse(r: Refusal) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: r.detail }), {
          status: r.status,
          headers: r.code ? { "X-Sharecut-Error-Code": r.code } : {},
        }),
    ),
  );
}

function mount(edit: PendingEditView) {
  useDawStore.getState().hydrate(
    path,
    minimalProject({
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
    } as never),
  );
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
    <PendingEditOverlay
      edits={[edit]}
      trackId="host"
      zoomPxPerSec={10}
      timelineWidthPx={1000}
      selectedId={edit.id}
      onSelect={vi.fn()}
    />,
  );
}

function overlayStyle(): string {
  return (document.querySelector(".pending-overlay") as HTMLElement).style
    .cssText;
}

function drag(edge: "start" | "end", dx: number) {
  const handle = document.querySelector(
    `.pending-handle.${edge}`,
  ) as HTMLElement;
  fireEvent.pointerDown(handle, { clientX: 100, pointerId: 7 });
  fireEvent.pointerMove(handle, { clientX: 100 + dx, pointerId: 7 });
  fireEvent.pointerUp(handle, { clientX: 100 + dx, pointerId: 7 });
}

async function dragAndSettle(edge: "start" | "end", dx: number) {
  drag(edge, dx);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  await waitFor(() =>
    expect(useDawStore.getState().pendingRetimeInFlight).toBeNull(),
  );
}

function expectRefusalShown(
  r: Refusal,
  edge: string,
  before: string,
  edit: PendingEditView,
) {
  const said = useDawStore.getState().statusAnnouncement;
  expect(said).toBe(r.sentence(edge));
  expect(said).not.toContain(r.detail);
  expect(useDawStore.getState().feedbackToast?.tone).toBe("error");
  expect(hasDocumentDrafts()).toBe(false);
  const saved = useDawStore.getState().project?.pending_edits[0];
  expect(saved?.source_start).toBe(edit.source_start);
  expect(saved?.source_end).toBe(edit.source_end);
  expect(overlayStyle()).toBe(before);
}

describe("a refused edge-drag save on a pending edit (#4373)", () => {
  beforeEach(() => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    resetDocumentAuthority();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe.each(REFUSALS)("$label", (r) => {
    it.each(
      KINDS.flatMap(([kind, o]) => [
        [kind, "start", o],
        [kind, "end", o],
      ]),
    )(
      "%s, %s edge: announces a plain sentence and returns the edge",
      async (_kind, edge, overrides) => {
        refuse(r);
        const edit = editWith(overrides as Partial<PendingEditView>);
        mount(edit);
        const before = overlayStyle();
        await dragAndSettle(
          edge as "start" | "end",
          edge === "start" ? 10 : 30,
        );
        expectRefusalShown(r, edge as string, before, edit);
      },
    );

    it("announces the same sentence on a coarse pointer", async () => {
      document.documentElement.style.setProperty("--touch-min", "2.75rem");
      const rect = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockReturnValue({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 200,
          bottom: 96,
          width: 200,
          height: 96,
          toJSON: () => ({}),
        });
      useDawStore.setState({ pointerKind: "coarse" });
      refuse(r);
      const edit = editWith({
        source_end: 14,
        source_end_timeline: 14,
        timeline_end: 14,
        timeline_spans: [{ start: SAVED_START, end: 14 }],
      });
      mount(edit);
      const region = document.querySelector(".pending-overlay") as HTMLElement;
      await waitFor(() =>
        expect(region).toHaveAttribute("data-coarse-handles", "ready"),
      );
      const before = overlayStyle();
      await dragAndSettle("end", 30);
      expectRefusalShown(r, "end", before, edit);
      rect.mockRestore();
      document.documentElement.style.removeProperty("--touch-min");
      useDawStore.setState({ pointerKind: "fine" });
    });
  });
});
