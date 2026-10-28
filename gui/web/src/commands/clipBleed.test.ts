import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { undoHistory } from "../api";
import {
  type ClipBleedInspection,
  loadClipBleedInspection,
  type OpaqueBleedRestoreTarget,
  restoreClipBleed,
} from "../api/clipBleed";
import { resetDocumentAuthority } from "../document/authorityState";
import { bleedAttenuationRegionKey } from "../edit/bleedAttenuation";
import { clipBleedSession } from "../edit/clipBleedSession";
import { beginClipPlacement, cancelClipPlacement } from "../edit/clipPlacement";
import { useDawStore } from "../state/dawStore";
import { trackEditSave } from "../state/documentSendOrder";
import { deferred } from "../test/deferred";
import { minimalProject, sampleTrack } from "../test/fixtures";
import {
  type ClipRow,
  HISTORY_ROOT_ID,
  parseHistoryEntryId,
} from "../types/project";
import { ApiError } from "../utils/apiError";
import { COMMANDS } from "./catalog";
import { registerClipBleedCommands, undoClipBleed } from "./clipBleed";
import { clearRegisteredCommands, execute } from "./execute";
import { _resetHistoryMovesForTests, registerHistoryCommands } from "./history";
import { executePointerCommand } from "./pointer";
import {
  _resetTrackMutateChainForTests,
  enqueueTrackMutate,
} from "./trackMutation";

vi.mock("../api/clipBleed", () => ({
  loadClipBleedInspection: vi.fn(),
  restoreClipBleed: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  undoHistory: vi.fn(),
}));
vi.mock("./trackMix", () => ({ flushPendingMix: vi.fn(async () => {}) }));

const path = "/tmp/bleed/episode.project.json";
const head = parseHistoryEntryId("restore-head")!;
const occurrence = { trackId: "host", clipId: "clip-1", clipLabel: "Host" };
const clip: ClipRow = {
  id: occurrence.clipId,
  track_id: occurrence.trackId,
  source_start: 0,
  source_end: 10,
  timeline_start: 0,
  timeline_end: 10,
  source_id: "recording-1",
  source_duration_sec: 10,
  recording_key: "recording-1",
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
};
const target = Object.freeze({
  opaque: "server-issued-target",
}) as unknown as OpaqueBleedRestoreTarget;
const inspection: ClipBleedInspection = {
  clipLabel: occurrence.clipLabel,
  planState: "ready",
  planReasons: [],
  artifactState: "stale",
  restoreState: "none",
  savedSourceSpans: [],
  fadeSec: 0.005,
  reduction: "mute",
  attenuationDb: null,
  regions: [
    {
      trackId: occurrence.trackId,
      occurrenceId: occurrence.clipId,
      kind: "late_gate",
      sourceSpan: { start: 2, end: 4 },
      timelineSpan: { start: 2, end: 4 },
      actualSourceSpan: { start: 2, end: 4 },
      restore: { state: "available", target, sourceSpan: { start: 2, end: 4 } },
    },
    {
      trackId: occurrence.trackId,
      occurrenceId: occurrence.clipId,
      kind: "bleed_mute:off_speaker",
      sourceSpan: { start: 6, end: 8 },
      timelineSpan: { start: 6, end: 8 },
      actualSourceSpan: { start: 6, end: 8 },
      restore: {
        state: "available",
        target: Object.freeze({
          different: true,
        }) as unknown as OpaqueBleedRestoreTarget,
        sourceSpan: { start: 6, end: 8 },
      },
    },
  ],
};
const key = bleedAttenuationRegionKey(inspection.regions[0]);
const otherKey = bleedAttenuationRegionKey(inspection.regions[1]);

function setHead(next = head) {
  const project = useDawStore.getState().project!;
  useDawStore.setState({
    project: { ...project, history: { ...project.history, head_id: next } },
  });
}
async function selectRegion() {
  await clipBleedSession.open(occurrence);
  expect(clipBleedSession.select(key)).toBe(true);
  useDawStore.getState().setSelection({
    kind: "bleedAttenuation",
    id: occurrence.clipId,
    trackId: occurrence.trackId,
    regionKey: key,
  });
}
function holdQueue() {
  const gate = deferred<void>();
  const pending = enqueueTrackMutate(() => gate.promise);
  return { release: () => gate.resolve(), pending };
}

beforeEach(async () => {
  vi.clearAllMocks();
  clipBleedSession.retire();
  _resetTrackMutateChainForTests();
  _resetHistoryMovesForTests();
  cancelClipPlacement();
  clearRegisteredCommands();
  registerClipBleedCommands();
  registerHistoryCommands();
  resetDocumentAuthority(path);
  useDawStore.setState({
    projectPath: path,
    projectEpoch: 7,
    project: minimalProject({
      project_path: path,
      tracks: [sampleTrack()],
      clips: { tracks: { host: [clip] }, clip_count: 1 },
    }),
    guestMode: null,
    heldTrim: null,
    joinMutationInFlight: false,
    timelineDragging: false,
    rangeBusy: false,
    selection: null,
    feedbackToast: null,
    statusAnnouncement: "",
  });
  vi.mocked(loadClipBleedInspection).mockResolvedValue(inspection);
  vi.mocked(restoreClipBleed).mockImplementation(async () => {
    setHead();
    return { status: "acknowledged", historyHead: head };
  });
  vi.mocked(undoHistory).mockImplementation(async () => {
    setHead(HISTORY_ROOT_ID);
    return HISTORY_ROOT_ID;
  });
  await selectRegion();
});
afterEach(() => {
  cancelClipPlacement();
  clipBleedSession.retire();
  resetDocumentAuthority();
});

describe("edit.restoreClipBleed", () => {
  it("sends the selected opaque target unchanged and offers exact acknowledged Undo", async () => {
    expect(COMMANDS["edit.restoreClipBleed"]).toMatchObject({
      when: "hostProjectLoaded",
      paletteRunnable: false,
    });
    expect(await execute("edit.restoreClipBleed")).toEqual({ status: "ok" });
    expect(restoreClipBleed).toHaveBeenCalledExactlyOnceWith(path, target);
    expect(vi.mocked(restoreClipBleed).mock.calls[0][1]).toBe(target);
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Restore choice saved",
      undo: head,
    });
    const receipt = clipBleedSession.getSnapshot()!.undo!;
    expect(receipt.expectedHeadId).toBe(head);
    expect(loadClipBleedInspection).toHaveBeenCalledTimes(1);
    expect(await undoClipBleed(receipt)).toEqual({ status: "ok" });
    expect(undoHistory).toHaveBeenCalledExactlyOnceWith(path, {
      expectedHeadId: head,
      scope: receipt.scope,
    });
    expect(clipBleedSession.getSnapshot()?.undo).toBeNull();
  });

  it("serializes with existing timeline mutations", async () => {
    const gate = holdQueue();
    const pending = executePointerCommand("edit.restoreClipBleed");
    await Promise.resolve();
    expect(restoreClipBleed).not.toHaveBeenCalled();
    gate.release();
    await gate.pending;
    expect(await pending).toEqual({ status: "ok" });
    expect(restoreClipBleed).toHaveBeenCalledTimes(1);
  });

  it.each([
    "region",
    "selection",
    "opening",
    "epoch",
    "guest",
    "join",
    "drag",
    "busy",
    "trim",
    "placement",
    "refresh",
    "geometry",
  ] as const)(
    "refuses a %s change while waiting in the real queue",
    async (change) => {
      const gate = holdQueue();
      const pending = executePointerCommand("edit.restoreClipBleed");
      if (change === "region") {
        clipBleedSession.select(otherKey);
        useDawStore.getState().setSelection({
          kind: "bleedAttenuation",
          id: clip.id,
          trackId: clip.track_id,
          regionKey: otherKey,
        });
      }
      if (change === "selection") useDawStore.getState().setSelection(null);
      if (change === "opening") resetDocumentAuthority(path);
      if (change === "epoch") useDawStore.setState({ projectEpoch: 8 });
      if (change === "guest") useDawStore.setState({ guestMode: "edit" });
      if (change === "join")
        useDawStore.setState({ joinMutationInFlight: true });
      if (change === "drag") useDawStore.setState({ timelineDragging: true });
      if (change === "busy") useDawStore.setState({ rangeBusy: true });
      if (change === "trim")
        expect(
          useDawStore.getState().changeHeldTrim({
            kind: "begin",
            token: Symbol("trim"),
            target: {
              trackId: clip.track_id,
              clipId: clip.id,
              edge: "in",
              mode: "gap",
            },
          }),
        ).toEqual({ kind: "accepted" });
      if (change === "placement")
        expect(beginClipPlacement(clip.id)).not.toBeNull();
      if (change === "refresh") {
        await clipBleedSession.refresh();
        clipBleedSession.select(key);
      }
      if (change === "geometry") {
        const project = useDawStore.getState().project!;
        useDawStore.setState({
          project: {
            ...project,
            clips: {
              tracks: {
                host: [{ ...clip, timeline_start: 1, timeline_end: 11 }],
              },
              clip_count: 1,
            },
          },
        });
      }
      gate.release();
      await gate.pending;
      expect(await pending).toMatchObject({ status: "disabled" });
      expect(restoreClipBleed).not.toHaveBeenCalled();
    },
  );

  it.each(["share:review-token", path])(
    "checks host access even through pointer dispatch at %s",
    async (projectPath) => {
      useDawStore.setState({
        projectPath,
        guestMode: projectPath === path ? "edit" : null,
      });
      expect(
        await executePointerCommand("edit.restoreClipBleed"),
      ).toMatchObject({
        status: "disabled",
      });
      expect(restoreClipBleed).not.toHaveBeenCalled();
    },
  );

  it("allows only one concurrent restore", async () => {
    const reply = deferred<Awaited<ReturnType<typeof restoreClipBleed>>>();
    vi.mocked(restoreClipBleed).mockReturnValueOnce(reply.promise);
    const pending = executePointerCommand("edit.restoreClipBleed");
    await vi.waitFor(() => expect(restoreClipBleed).toHaveBeenCalledTimes(1));
    expect(clipBleedSession.getSnapshot()?.action.state).toBe("saving");
    expect(await executePointerCommand("edit.restoreClipBleed")).toMatchObject({
      status: "disabled",
      reason: "Saving Restore choice…",
    });
    setHead();
    reply.resolve({ status: "acknowledged", historyHead: head });
    expect(await pending).toEqual({ status: "ok" });
  });

  it.each(["queued", "noop", "unconfirmed"] as const)(
    "does not report %s as a saved change",
    async (status) => {
      vi.mocked(restoreClipBleed).mockResolvedValueOnce({ status });
      expect(
        await executePointerCommand("edit.restoreClipBleed"),
      ).toMatchObject({
        status: "disabled",
      });
      expect(clipBleedSession.getSnapshot()?.undo).toBeNull();
      expect(useDawStore.getState().feedbackToast?.undo).toBeNull();
      expect(useDawStore.getState().statusAnnouncement).not.toBe(
        "Restore choice saved",
      );
    },
  );

  it.each([
    ["bleed_restore_changed", "STALE_TARGET", null],
    ["other_conflict", "failed", key],
  ] as const)(
    "maps only server code %s to %s",
    async (serverCode, localCode, selectedKey) => {
      vi.mocked(restoreClipBleed).mockRejectedValueOnce(
        new ApiError("Refused", serverCode, 409),
      );
      expect(
        await executePointerCommand("edit.restoreClipBleed"),
      ).toMatchObject({ status: "disabled" });
      expect(clipBleedSession.getSnapshot()).toMatchObject({
        selectedKey,
        action: { state: "error", code: localCode },
        undo: null,
      });
    },
  );

  it("ignores an acknowledgement from a previous opening", async () => {
    const reply = deferred<Awaited<ReturnType<typeof restoreClipBleed>>>();
    vi.mocked(restoreClipBleed).mockReturnValueOnce(reply.promise);
    const pending = executePointerCommand("edit.restoreClipBleed");
    await vi.waitFor(() => expect(restoreClipBleed).toHaveBeenCalledTimes(1));
    resetDocumentAuthority(path);
    reply.resolve({ status: "acknowledged", historyHead: head });
    expect(await pending).toMatchObject({ status: "disabled" });
    expect(clipBleedSession.getSnapshot()).toBeNull();
    expect(useDawStore.getState().feedbackToast).toBeNull();
  });

  it("refuses copied or retired Undo receipts and preserves the exact head on stale Undo", async () => {
    await executePointerCommand("edit.restoreClipBleed");
    const receipt = clipBleedSession.getSnapshot()!.undo!;
    expect(await undoClipBleed({ ...receipt })).toMatchObject({
      status: "disabled",
    });
    expect(undoHistory).not.toHaveBeenCalled();
    vi.mocked(undoHistory).mockRejectedValueOnce(
      new ApiError("Peer edit", "history_stale", 409),
    );
    expect(await undoClipBleed(receipt)).toMatchObject({ status: "disabled" });
    expect(undoHistory).toHaveBeenCalledWith(path, {
      expectedHeadId: head,
      scope: receipt.scope,
    });
    expect(clipBleedSession.getSnapshot()?.action).toMatchObject({
      state: "error",
    });
    expect(clipBleedSession.getSnapshot()?.undo).toBeNull();
    expect(await undoClipBleed(receipt)).toMatchObject({ status: "disabled" });
    expect(undoHistory).toHaveBeenCalledTimes(1);
  });

  it("lets exact Undo wait through the existing save helper without adopting a later head", async () => {
    await executePointerCommand("edit.restoreClipBleed");
    const receipt = clipBleedSession.getSnapshot()!.undo!;
    const save = deferred<void>();
    const tracked = trackEditSave(path, save.promise);
    useDawStore.setState({ rangeBusy: true });
    const pending = undoClipBleed(receipt);
    expect(clipBleedSession.getSnapshot()?.action.state).toBe("undoing");
    expect(undoHistory).not.toHaveBeenCalled();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Undo runs after save",
    );
    setHead(parseHistoryEntryId("later-save")!);
    vi.mocked(undoHistory).mockRejectedValueOnce(
      new ApiError("Changed", "history_stale", 409),
    );
    save.resolve();
    await tracked;
    expect(await pending).toMatchObject({ status: "disabled" });
    expect(undoHistory).toHaveBeenCalledExactlyOnceWith(path, {
      expectedHeadId: head,
      scope: receipt.scope,
    });
    expect(clipBleedSession.getSnapshot()?.undo).toBeNull();
  });
});
