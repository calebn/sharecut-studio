import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { resetDocumentAuthority } from "../document/authorityState";
import { hasDocumentDrafts } from "../document/pendingDrafts";
import { useWaveformSnapTicks } from "../hooks/useWaveformSnapTicks";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, pendingEditView } from "../test/fixtures";
import type { ClipRow, PendingEditView } from "../types/project";
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

function mount(edit: PendingEditView, clip: Partial<ClipRow> = {}) {
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
              ...clip,
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
  return render(overlay(edit, edit.id));
}

const onSelect = vi.fn();

function overlay(edit: PendingEditView, selectedId: string | null) {
  return (
    <PendingEditOverlay
      edits={[edit]}
      trackId="host"
      zoomPxPerSec={10}
      timelineWidthPx={1000}
      selectedId={selectedId}
      onSelect={onSelect}
    />
  );
}

function hold() {
  let answer!: (r: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => pending),
  );
  return (r: Refusal) =>
    answer(
      new Response(JSON.stringify({ detail: r.detail }), { status: r.status }),
    );
}

async function idle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const CONFLICT = REFUSALS[0];

function overlayStyle(): string {
  return (document.querySelector(".pending-overlay") as HTMLElement).style
    .cssText;
}

function drag(edge: "start" | "end", dx: number, pointerId = 7) {
  const handle = document.querySelector(
    `.pending-handle.${edge}`,
  ) as HTMLElement;
  fireEvent.pointerDown(handle, { clientX: 100, pointerId });
  fireEvent.pointerMove(handle, { clientX: 100 + dx, pointerId });
  fireEvent.pointerUp(handle, { clientX: 100 + dx, pointerId });
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
    onSelect.mockClear();
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

  describe("while the save is in flight", () => {
    const edit = editWith({});

    it("keeps the drag settling, so a second drag on the handle is ignored", async () => {
      const answer = hold();
      mount(edit);
      drag("end", 30);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      expect(useDawStore.getState().pendingRetimeInFlight).toBe("cut_1");
      expect(onSelect).toHaveBeenCalledTimes(1);
      drag("end", -20, 8);
      await idle();
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(useDawStore.getState().pendingRetimeInFlight).toBe("cut_1");
      answer(CONFLICT);
      await waitFor(() =>
        expect(useDawStore.getState().pendingRetimeInFlight).toBeNull(),
      );
      expect(useDawStore.getState().statusAnnouncement).toBe(
        TEXT_PER_EDGE("end"),
      );
    });

    it("keeps the drag settling on an edit placed in a clip that is offset on the timeline", async () => {
      const offset = editWith({
        source_start_timeline: SAVED_START + 10,
        source_end_timeline: SAVED_END + 10,
        timeline_start: SAVED_START + 10,
        timeline_end: SAVED_END + 10,
        timeline_spans: [{ start: SAVED_START + 10, end: SAVED_END + 10 }],
      });
      const answer = hold();
      mount(offset, { timeline_start: 10, timeline_end: 40 });
      drag("end", 30);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      expect(onSelect).toHaveBeenCalledTimes(1);
      drag("end", -20, 8);
      await idle();
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      answer(CONFLICT);
      await waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(
          TEXT_PER_EDGE("end"),
        ),
      );
    });

    it("announces a refusal after the edit is deselected or the pointer is cancelled", async () => {
      const answer = hold();
      const view = mount(edit);
      drag("end", 30);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      fireEvent.pointerCancel(
        document.querySelector(".pending-handle.end") as HTMLElement,
        { pointerId: 7 },
      );
      view.rerender(overlay(edit, null));
      answer(CONFLICT);
      await waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(
          TEXT_PER_EDGE("end"),
        ),
      );
    });

    it("still announces the refusal when another client moves the edge", async () => {
      const answer = hold();
      mount(edit);
      drag("end", 30);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const moved = { ...edit, source_end: 8, source_end_timeline: 8 };
      applyDocumentSnapshot({
        server_seq: 2,
        project: minimalProject({
          project_path: path,
          pending_edits: [moved],
          clips: {
            tracks: { host: [clipRow({ id: "c1", track_id: "host" })] },
          },
        } as never),
      });
      answer(CONFLICT);
      await waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(
          TEXT_PER_EDGE("end"),
        ),
      );
    });

    it("still announces the refusal when another client deletes the edit", async () => {
      const answer = hold();
      mount(edit);
      drag("end", 30);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      applyDocumentSnapshot({
        server_seq: 2,
        project: minimalProject({
          project_path: path,
          pending_edits: [],
        } as never),
      });
      answer(CONFLICT);
      await waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(
          TEXT_PER_EDGE("end"),
        ),
      );
    });

    it("stays silent when the project changes before the refusal arrives", async () => {
      const answer = hold();
      mount(edit);
      drag("end", 30);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
      answer(CONFLICT);
      await idle();
      expect(useDawStore.getState().statusAnnouncement).toBe("");
    });
  });

  describe("when nothing was refused", () => {
    it("stays silent after a cancel during the snap lookup", async () => {
      let resolveTicks!: (ticks: number[]) => void;
      vi.mocked(useWaveformSnapTicks).mockReturnValue({
        ticks: [],
        resolveTicks: vi.fn(
          () =>
            new Promise<number[]>((resolve) => {
              resolveTicks = resolve;
            }),
        ),
      } as never);
      const edit = editWith({});
      vi.stubGlobal("fetch", vi.fn());
      const view = mount(edit);
      drag("end", 30);
      await waitFor(() => expect(resolveTicks).toBeDefined());
      view.rerender(overlay(edit, null));
      resolveTicks([]);
      await idle();
      expect(fetch).not.toHaveBeenCalled();
      expect(useDawStore.getState().statusAnnouncement).toBe("");
      vi.mocked(useWaveformSnapTicks).mockReturnValue({
        ticks: [],
        resolveTicks: vi.fn(async () => []),
      } as never);
    });

    it("stays silent when the save lands", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
      );
      mount(editWith({}));
      await dragAndSettle("end", 30);
      expect(useDawStore.getState().statusAnnouncement).toBe("");
      expect(useDawStore.getState().feedbackToast).toBeNull();
    });

    it("stays silent when the host is unavailable and the save is queued to retry", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ detail: "Disk full" }), {
              status: 503,
            }),
        ),
      );
      mount(editWith({}));
      await dragAndSettle("end", 30);
      expect(useDawStore.getState().statusAnnouncement).toBe("");
      expect(useDawStore.getState().feedbackToast).toBeNull();
    });
  });
});
