import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClipBleedInspection,
  ClipBleedRequest,
  OpaqueBleedRestoreTarget,
  RestoreOutcome,
} from "../api/clipBleed";
import {
  documentAuthority,
  documentScope,
  noteOwnCommandHead,
  resetDocumentAuthority,
} from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { minimalProject, sampleTrack } from "../test/fixtures";
import {
  type ClipRow,
  HISTORY_ROOT_ID,
  type ProjectView,
  parseHistoryEntryId,
} from "../types/project";
import { bleedAttenuationRegionKey } from "./bleedAttenuation";
import { createClipBleedSession } from "./clipBleedSession";

const path = "/tmp/bleed/episode.project.json";
const occurrence = { trackId: "host", clipId: "clip-1", clipLabel: "Host" };
const head = parseHistoryEntryId("restore-head")!;
const peerHead = parseHistoryEntryId("peer-head")!;

function clip(overrides: Partial<ClipRow> = {}): ClipRow {
  return {
    id: "clip-1",
    track_id: "host",
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
    mute_regions: [],
    ...overrides,
  };
}
function project(rows = [clip()]): ProjectView {
  return minimalProject({
    project_path: path,
    tracks: [sampleTrack()],
    clips: { tracks: { host: rows }, clip_count: rows.length },
  });
}
function inspection(clipId = occurrence.clipId): ClipBleedInspection {
  const target = Object.freeze({
    opaque: Symbol("issued-target"),
  }) as unknown as OpaqueBleedRestoreTarget;
  return {
    clipLabel: "Host",
    planState: "ready",
    planReasons: [],
    artifactState: "current",
    restoreState: "none",
    savedSourceSpans: [],
    fadeSec: 0.005,
    reduction: "attenuate",
    attenuationDb: -24,
    regions: [
      {
        trackId: "host",
        occurrenceId: clipId,
        kind: "late_gate",
        sourceSpan: { start: 2, end: 4 },
        timelineSpan: { start: 2, end: 4 },
        actualSourceSpan: { start: 2.1, end: 4.1 },
        restore: {
          state: "available",
          target,
          sourceSpan: { start: 2, end: 4 },
        },
      },
    ],
  };
}
function replaceProject(next: ProjectView): void {
  useDawStore.setState({ project: next });
}
function currentProject(): ProjectView {
  return useDawStore.getState().project!;
}
function setHead(nextHead = head): void {
  const current = currentProject();
  replaceProject({
    ...current,
    history: { ...current.history, head_id: nextHead },
  });
}
const disposals: Array<() => void> = [];
function harness(activeOccurrence = occurrence) {
  const reads: Array<{
    request: ClipBleedRequest;
    signal: AbortSignal;
    response: ReturnType<typeof deferred<ClipBleedInspection>>;
  }> = [];
  const load = vi.fn((request: ClipBleedRequest, signal: AbortSignal) => {
    const response = deferred<ClipBleedInspection>();
    reads.push({ request, signal, response });
    return response.promise;
  });
  const session = createClipBleedSession(load);
  disposals.push(session.dispose);
  const ready = async () => {
    const opening = session.open(activeOccurrence);
    const value = inspection(activeOccurrence.clipId);
    reads.at(-1)!.response.resolve(value);
    await opening;
    return value;
  };
  const selected = async () => {
    const value = await ready();
    expect(session.select(bleedAttenuationRegionKey(value.regions[0]))).toBe(
      true,
    );
    return session.currentTarget()!;
  };
  return { session, reads, load, ready, selected };
}
beforeEach(() => {
  resetDocumentAuthority(path);
  useDawStore.setState({
    ...useDawStore.getInitialState(),
    projectPath: path,
    project: project(),
    projectEpoch: 7,
  });
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  resetDocumentAuthority();
});

describe("clip bleed occurrence session", () => {
  it("clears a ready region selection for gesture rollback and refuses clearing during a save", async () => {
    const { session, selected } = harness();
    const target = await selected();
    expect(session.select(null)).toBe(true);
    expect(session.getSnapshot()?.selectedKey).toBeNull();
    expect(session.currentTarget()).toBeNull();
    const key = bleedAttenuationRegionKey(inspection().regions[0]);
    expect(session.select(key)).toBe(true);
    expect(session.beginRestore(target)).not.toBeNull();
    expect(session.select(null)).toBe(false);
    expect(session.getSnapshot()?.selectedKey).toBe(key);
  });
  it("publishes stable snapshots and subscriptions for the active occurrence", async () => {
    const { session, load, ready } = harness();
    const changed = vi.fn();
    const unsubscribe = session.subscribe(changed);
    const value = await ready();
    const snapshot = session.getSnapshot();
    expect(snapshot?.read).toEqual({ state: "ready", inspection: value });
    expect(session.getSnapshot()).toBe(snapshot);
    useDawStore.setState({ playheadSec: 3 });
    expect(session.getSnapshot()).toBe(snapshot);
    await session.open(occurrence);
    expect(load).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
    session.retire();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot()).toBeNull();
  });
  it("selects only a region issued by the current inspection", async () => {
    const { session, ready } = harness();
    const value = await ready();
    expect(session.currentTarget()).toBeNull();
    expect(session.select("forged-key")).toBe(false);
    expect(session.getSnapshot()?.selectedKey).toBeNull();
    const key = bleedAttenuationRegionKey(value.regions[0]);
    expect(session.select(key)).toBe(true);
    const captured = session.currentTarget()!;
    expect(captured.target).toBe(
      value.regions[0].restore.state === "available"
        ? value.regions[0].restore.target
        : null,
    );
    expect(session.currentTarget(captured)?.target).toBe(captured.target);
    expect(
      session.currentTarget({ ...captured, target: { ...captured.target } }),
    ).toBeNull();
    expect(session.select("forged-key")).toBe(false);
    expect(session.getSnapshot()?.selectedKey).toBe(key);
  });
  it("clears selection on refresh even when the replacement region has the same key", async () => {
    const { session, reads, selected } = harness();
    const captured = await selected();
    const refresh = session.refresh();
    expect(session.currentTarget(captured)).toBeNull();
    expect(session.getSnapshot()?.selectedKey).toBeNull();
    const replacement = inspection();
    reads[1].response.resolve(replacement);
    await refresh;
    expect(session.getSnapshot()?.read).toEqual({
      state: "ready",
      inspection: replacement,
    });
    expect(session.getSnapshot()?.selectedKey).toBeNull();
    expect(session.currentTarget()).toBeNull();
    session.select(bleedAttenuationRegionKey(replacement.regions[0]));
    expect(session.currentTarget(captured)).toBeNull();
  });
  it.each(["success", "error"] as const)(
    "ignores an obsolete GET %s after refresh",
    async (result) => {
      const { session, reads } = harness();
      const old = session.open(occurrence);
      const fresh = session.refresh();
      expect(reads[0].signal.aborted).toBe(true);
      const latest = inspection();
      reads[1].response.resolve(latest);
      await fresh;
      const accepted = session.getSnapshot();
      if (result === "success") reads[0].response.resolve(inspection());
      else reads[0].response.reject(new Error("old request failed"));
      await old;
      expect(session.getSnapshot()).toBe(accepted);
      expect(accepted?.read).toEqual({ state: "ready", inspection: latest });
    },
  );
  it("retires a GET on same-path reopen with unchanged project epoch", async () => {
    const { session, reads } = harness();
    const oldScope = documentScope();
    const old = session.open(occurrence);
    resetDocumentAuthority(path);
    expect(documentScope().generation).toBeGreaterThan(oldScope.generation);
    expect(useDawStore.getState().projectEpoch).toBe(7);
    expect(reads[0].signal.aborted).toBe(true);
    expect(session.getSnapshot()).toBeNull();
    const fresh = session.open(occurrence);
    reads[0].response.resolve(inspection());
    await old;
    expect(session.getSnapshot()?.read.state).toBe("loading");
    const latest = inspection();
    reads[1].response.resolve(latest);
    await fresh;
    expect(session.getSnapshot()?.read).toEqual({
      state: "ready",
      inspection: latest,
    });
    expect(session.currentTarget()).toBeNull();
  });
  it.each([
    ["move", { timeline_start: 1, timeline_end: 11 }],
    ["trim", { source_end: 9, timeline_end: 9 }],
    [
      "source replacement",
      { source_id: "replacement", recording_key: "replacement-key" },
    ],
  ] as const)(
    "ignores a deferred GET after occurrence %s",
    async (_name, changes) => {
      const { session, reads } = harness();
      const pending = session.open(occurrence);
      replaceProject(project([clip(changes)]));
      expect(reads[0].signal.aborted).toBe(true);
      reads[0].response.resolve(inspection());
      await pending;
      expect(session.getSnapshot()).toBeNull();
      expect(session.currentTarget()).toBeNull();
    },
  );
  it("keeps an in-flight read when a late update replaces the project view with identical content", async () => {
    const { session, reads } = harness();
    const pending = session.open(occurrence);
    replaceProject({ ...currentProject() });
    expect(reads[0].signal.aborted).toBe(false);
    const value = inspection();
    reads[0].response.resolve(value);
    await pending;
    expect(session.getSnapshot()?.read).toEqual({
      state: "ready",
      inspection: value,
    });
  });
  it("keeps a loading read through a late transcript-words hydration", async () => {
    const { session, reads } = harness();
    const pending = session.open(occurrence);
    const current = currentProject();
    replaceProject({
      ...current,
      meta: { ...current.meta, hydration: { transcript_words: true } },
    } as ProjectView);
    reads[0].response.resolve(inspection());
    await pending;
    expect(session.getSnapshot()?.read.state).toBe("ready");
  });
  it("still marks a loading read stale when a peer head lands before the read returns", async () => {
    const { session, reads } = harness();
    const pending = session.open(occurrence);
    setHead(peerHead);
    reads[0].response.resolve(inspection());
    await pending;
    expect(session.getSnapshot()?.read.state).toBe("error");
    expect(session.currentTarget()).toBeNull();
  });
  it("retires a loading read when its implicit occurrence materializes mid-read", async () => {
    const implicit = { ...occurrence, clipId: "clip_host_full" };
    const lane = sampleTrack({
      has_source_audio: true,
      duration_sec: 10,
      range_media_seal: "same-media",
    });
    replaceProject({ ...project([]), tracks: [lane] });
    const { session, reads } = harness(implicit);
    const pending = session.open(implicit);
    const materialized = clip({
      id: implicit.clipId,
      source_id: null,
      source_duration_sec: null,
      recording_key: null,
    });
    const next = { ...project([materialized]), tracks: [lane] };
    replaceProject({ ...next, history: { ...next.history, head_id: head } });
    reads[0].response.resolve(inspection(implicit.clipId));
    await pending;
    expect(session.getSnapshot()).toBeNull();
  });
  it("retires a deleted occurrence and its pending action", async () => {
    const { session, selected } = harness();
    const captured = await selected();
    const ticket = session.beginRestore(captured)!;
    replaceProject(project([]));
    expect(session.getSnapshot()).toBeNull();
    expect(session.currentTarget(captured)).toBeNull();
    expect(
      session.finishRestore(ticket, {
        status: "acknowledged",
        historyHead: head,
      }),
    ).toBe(false);
  });
  it.each(["path", "epoch", "basis", "head", "fx"] as const)(
    "retires the selected target when its %s changes",
    async (change) => {
      const { session, selected } = harness();
      const captured = await selected();
      if (change === "path")
        useDawStore.setState({ projectPath: "/tmp/other.json" });
      if (change === "epoch") useDawStore.setState({ projectEpoch: 8 });
      if (change === "basis") {
        documentAuthority.seq++;
        useDawStore.setState({ playheadSec: 1 });
      }
      if (change === "head") setHead(peerHead);
      if (change === "fx")
        replaceProject({
          ...currentProject(),
          effects_by_track: {
            host: [{ effect: "gain", params: { gain_db: -3 } }],
          },
        });
      expect(session.currentTarget(captured)).toBeNull();
      expect(session.getSnapshot()?.selectedKey ?? null).toBeNull();
      expect(session.getSnapshot()?.undo ?? null).toBeNull();
    },
  );
  it("reports a read error and allows explicit refresh", async () => {
    const { session, reads } = harness();
    const pending = session.open(occurrence);
    reads[0].response.reject(new Error("Evidence unavailable"));
    await pending;
    expect(session.getSnapshot()?.read).toEqual({
      state: "error",
      message: "Evidence unavailable",
    });
    expect(session.currentTarget()).toBeNull();
    const retry = session.refresh();
    reads[1].response.resolve(inspection());
    await retry;
    expect(session.getSnapshot()?.read.state).toBe("ready");
  });
  it("accepts its own acknowledged head before projection and retires Undo on peer head", async () => {
    const { session, selected } = harness();
    const captured = await selected();
    const ticket = session.beginRestore(captured)!;
    noteOwnCommandHead(captured.scope, {
      seq: 1,
      head,
      displayedFrom: HISTORY_ROOT_ID,
    });
    expect(
      session.finishRestore(ticket, {
        status: "acknowledged",
        historyHead: head,
      }),
    ).toBe(true);
    const receipt = session.getSnapshot()!.undo!;
    expect(receipt.expectedHeadId).toBe(head);
    expect(session.currentUndo(receipt)).toBe(true);
    expect(session.currentTarget()).toBeNull();
    setHead(peerHead);
    expect(session.currentUndo(receipt)).toBe(false);
    expect(session.getSnapshot()?.undo).toBeNull();
  });
  it("keeps a pending action through its own saved-choice and render projection", async () => {
    const { session, selected } = harness();
    const ticket = session.beginRestore(await selected())!;
    const changedClip = {
      ...clip(),
      bleed_restore: { regions: [{ start_s: 2, end_s: 4 }] },
    };
    const current = project([changedClip]);
    replaceProject({
      ...current,
      history: { ...current.history, head_id: head },
      render_status: { ...current.render_status, needs_rerender: true },
    });
    expect(session.currentTarget()).toBeNull();
    expect(session.getSnapshot()?.action.state).toBe("saving");
    expect(
      session.finishRestore(ticket, {
        status: "acknowledged",
        historyHead: head,
      }),
    ).toBe(true);
    expect(session.getSnapshot()?.undo?.expectedHeadId).toBe(head);
  });
  it.each(["refresh", "reopen", "move", "fx", "retire"] as const)(
    "cannot attach Undo when a pending action is retired by %s",
    async (change) => {
      const { session, reads, selected } = harness();
      const ticket = session.beginRestore(await selected())!;
      let refresh: Promise<void> | null = null;
      if (change === "refresh") refresh = session.refresh();
      if (change === "reopen") resetDocumentAuthority(path);
      if (change === "move")
        replaceProject(
          project([clip({ timeline_start: 1, timeline_end: 11 })]),
        );
      if (change === "fx")
        replaceProject({
          ...currentProject(),
          effects_by_track: {
            host: [{ effect: "gain", params: { gain_db: -3 } }],
          },
        });
      if (change === "retire") session.retire();
      setHead();
      expect(
        session.finishRestore(ticket, {
          status: "acknowledged",
          historyHead: head,
        }),
      ).toBe(false);
      expect(session.getSnapshot()?.undo ?? null).toBeNull();
      if (refresh) {
        reads.at(-1)!.response.resolve(inspection());
        await refresh;
      }
    },
  );
  it.each([
    { status: "queued" },
    { status: "noop" },
    { status: "unconfirmed" },
  ] satisfies RestoreOutcome[])(
    "offers no Undo for $status",
    async (outcome) => {
      const { session, selected } = harness();
      const ticket = session.beginRestore(await selected())!;
      expect(session.finishRestore(ticket, outcome)).toBe(true);
      expect(session.getSnapshot()?.undo).toBeNull();
      expect(session.currentTarget()).toBeNull();
    },
  );
  it("rejects a foreign ticket and does not adopt a mismatched acknowledged head", async () => {
    const { session, selected } = harness();
    const ticket = session.beginRestore(await selected())!;
    expect(
      session.finishRestore(
        { ...ticket },
        { status: "acknowledged", historyHead: head },
      ),
    ).toBe(false);
    setHead(peerHead);
    expect(
      session.finishRestore(ticket, {
        status: "acknowledged",
        historyHead: head,
      }),
    ).toBe(true);
    expect(session.getSnapshot()?.undo).toBeNull();
  });
  it("accepts only the issued Undo receipt and prevents concurrent actions", async () => {
    const { session, selected } = harness();
    const captured = await selected();
    const ticket = session.beginRestore(captured)!;
    expect(session.beginRestore(captured)).toBeNull();
    setHead();
    session.finishRestore(ticket, {
      status: "acknowledged",
      historyHead: head,
    });
    const receipt = session.getSnapshot()!.undo!;
    expect(session.beginUndo({ ...receipt })).toBeNull();
    const undo = session.beginUndo(receipt)!;
    expect(undo.kind).toBe("undo");
    expect(session.getSnapshot()?.action.state).toBe("undoing");
    expect(session.beginUndo(receipt)).toBeNull();
    expect(session.finishUndo(undo)).toBe(true);
    expect(session.getSnapshot()?.action.state).toBe("idle");
    expect(session.getSnapshot()?.undo).toBeNull();
  });
  it("retires the selected target after stale-target failure", async () => {
    const { session, selected } = harness();
    const captured = await selected();
    const ticket = session.beginRestore(captured)!;
    expect(
      session.failAction(ticket, {
        state: "error",
        code: "STALE_TARGET",
        message: "Refresh regions.",
      }),
    ).toBe(true);
    expect(session.getSnapshot()?.action.state).toBe("error");
    expect(session.getSnapshot()?.selectedKey).toBeNull();
    expect(session.currentTarget(captured)).toBeNull();
    expect(
      session.finishRestore(ticket, {
        status: "acknowledged",
        historyHead: head,
      }),
    ).toBe(false);
  });
  it("retires a target when its own acknowledged head arrives before projection", async () => {
    const { session, selected } = harness();
    const captured = await selected();
    noteOwnCommandHead(captured.scope, {
      seq: 1,
      head,
      displayedFrom: HISTORY_ROOT_ID,
    });
    expect(session.currentTarget(captured)).toBeNull();
    expect(session.getSnapshot()?.selectedKey).toBeNull();
  });

  it("keeps Undo when its implicit occurrence materializes at its acknowledged head", async () => {
    const implicit = { ...occurrence, clipId: "clip_host_full" };
    const lane = sampleTrack({
      has_source_audio: true,
      duration_sec: 10,
      range_media_seal: "same-media",
    });
    replaceProject({ ...project([]), tracks: [lane] });
    const { session, selected } = harness(implicit);
    const ticket = session.beginRestore(await selected())!;
    const materialized = {
      ...clip({ id: implicit.clipId, source_id: null }),
      origin_track_id: "host",
      join_left_clip_id: null,
      join_render_mode: "fade",
      join_crossfade_ms: 0,
      join_crossfade_blocked: null,
      clipping_regions: [],
      clipping_truncated: false,
      bleed_restore: { regions: [{ start_s: 2, end_s: 4 }] },
    };
    const next = { ...project([materialized]), tracks: [lane] };
    replaceProject({ ...next, history: { ...next.history, head_id: head } });
    expect(session.currentTarget()).toBeNull();
    expect(
      session.finishRestore(ticket, {
        status: "acknowledged",
        historyHead: head,
      }),
    ).toBe(true);
    const receipt = session.getSnapshot()!.undo!;
    expect(receipt.expectedHeadId).toBe(head);
    useDawStore.setState({ playheadSec: 1 });
    expect(session.currentUndo(receipt)).toBe(true);
    const replacement = { ...materialized, recording_key: "changed-recording" };
    replaceProject({
      ...next,
      clips: { tracks: { host: [replacement] }, clip_count: 1 },
    });
    expect(session.currentUndo(receipt)).toBe(false);
  });
  it("keeps implicit Undo when its own projection arrives after acknowledgement", async () => {
    const implicit = { ...occurrence, clipId: "clip_host_full" };
    const lane = sampleTrack({
      has_source_audio: true,
      duration_sec: 10,
      range_media_seal: "same-media",
    });
    replaceProject({ ...project([]), tracks: [lane] });
    const { session, selected } = harness(implicit);
    const captured = await selected();
    const ticket = session.beginRestore(captured)!;
    noteOwnCommandHead(captured.scope, {
      seq: 1,
      head,
      displayedFrom: HISTORY_ROOT_ID,
    });
    expect(
      session.finishRestore(ticket, {
        status: "acknowledged",
        historyHead: head,
      }),
    ).toBe(true);
    const receipt = session.getSnapshot()!.undo!;
    const next = {
      ...project([clip({ id: implicit.clipId, source_id: null })]),
      tracks: [lane],
    };
    replaceProject({ ...next, history: { ...next.history, head_id: head } });
    expect(session.currentUndo(receipt)).toBe(true);
    expect(session.getSnapshot()?.selectedKey).toBeNull();
  });

  it.each([
    "media",
    "source",
    "geometry",
    "fade",
    "mute",
    "automatic",
    "missing seal",
  ] as const)(
    "rejects implicit materialization with changed %s",
    async (change) => {
      const implicit = { ...occurrence, clipId: "clip_host_full" };
      const lane = sampleTrack({
        has_source_audio: true,
        duration_sec: 10,
        range_media_seal: change === "missing seal" ? undefined : "same-media",
      });
      replaceProject({ ...project([]), tracks: [lane] });
      const { session, selected } = harness(implicit);
      const ticket = session.beginRestore(await selected())!;
      const materialized = {
        ...clip({
          id: implicit.clipId,
          source_id: change === "source" ? "other" : null,
          timeline_start: change === "geometry" ? 1 : 0,
          fade_in_ms: change === "fade" ? 10 : 0,
          mute_regions: change === "mute" ? [{ start_s: 1, end_s: 2 }] : [],
        }),
        off_speaker_mute_regions:
          change === "automatic" ? [{ start_s: 1, end_s: 2 }] : [],
      };
      const next = {
        ...project([materialized]),
        tracks: [
          {
            ...lane,
            range_media_seal:
              change === "media" ? "changed-media" : lane.range_media_seal,
          },
        ],
      };
      replaceProject({ ...next, history: { ...next.history, head_id: head } });
      expect(
        session.finishRestore(ticket, {
          status: "acknowledged",
          historyHead: head,
        }),
      ).toBe(false);
      expect(session.getSnapshot()?.undo ?? null).toBeNull();
    },
  );
  it("keeps its pending Undo when the first materialized clip returns to implicit", async () => {
    const implicit = { ...occurrence, clipId: "clip_host_full" };
    const lane = sampleTrack({
      has_source_audio: true,
      duration_sec: 10,
      range_media_seal: "same-media",
    });
    const original = { ...project([]), tracks: [lane] };
    replaceProject(original);
    const { session, selected } = harness(implicit);
    const restore = session.beginRestore(await selected())!;
    const next = {
      ...project([clip({ id: implicit.clipId, source_id: null })]),
      tracks: [lane],
    };
    replaceProject({ ...next, history: { ...next.history, head_id: head } });
    session.finishRestore(restore, {
      status: "acknowledged",
      historyHead: head,
    });
    const receipt = session.getSnapshot()!.undo!;
    const undo = session.beginUndo(receipt)!;
    replaceProject(original);
    expect(session.getSnapshot()?.action.state).toBe("undoing");
    expect(session.finishUndo(undo)).toBe(true);
    expect(session.getSnapshot()?.action.state).toBe("idle");
    expect(session.getSnapshot()?.undo).toBeNull();
    useDawStore.setState({ playheadSec: 1 });
    expect(session.getSnapshot()).not.toBeNull();
  });
  it("retires an originally explicit occurrence deleted while Undo waits", async () => {
    const full = { ...occurrence, clipId: "clip_host_full" };
    const lane = sampleTrack({
      has_source_audio: true,
      duration_sec: 10,
      range_media_seal: "same-media",
    });
    replaceProject({
      ...project([clip({ id: full.clipId, source_id: null })]),
      tracks: [lane],
    });
    const { session, selected } = harness(full);
    const restore = session.beginRestore(await selected())!;
    setHead();
    session.finishRestore(restore, {
      status: "acknowledged",
      historyHead: head,
    });
    const receipt = session.getSnapshot()!.undo!;
    const undo = session.beginUndo(receipt)!;
    replaceProject({ ...project([]), tracks: [lane] });
    expect(session.finishUndo(undo)).toBe(false);
    expect(session.getSnapshot()).toBeNull();
  });
});

describe("pending action lifetime regressions", () => {
  it("retires a materialized recording replacement before Restore finishes", async () => {
    const implicit = { ...occurrence, clipId: "clip_host_full" };
    const lane = sampleTrack({
      has_source_audio: true,
      duration_sec: 10,
      range_media_seal: "same-media",
    });
    replaceProject({ ...project([]), tracks: [lane] });
    const { session, selected } = harness(implicit);
    const ticket = session.beginRestore(await selected())!;
    const materialized = clip({
      id: implicit.clipId,
      source_id: null,
      recording_key: "materialized-recording",
    });
    const first = { ...project([materialized]), tracks: [lane] };
    replaceProject({ ...first, history: { ...first.history, head_id: head } });
    expect(session.getSnapshot()?.action.state).toBe("saving");
    const replacement = {
      ...materialized,
      recording_key: "replacement-recording",
    };
    const next = { ...project([replacement]), tracks: [lane] };
    replaceProject({ ...next, history: { ...next.history, head_id: head } });
    const accepted = session.finishRestore(ticket, {
      status: "acknowledged",
      historyHead: head,
    });
    const receipt = session.getSnapshot()?.undo;
    expect(accepted).toBe(false);
    expect(receipt ?? null).toBeNull();
  });

  it("cannot revive a materialized pending Restore through its original implicit occurrence", async () => {
    const implicit = { ...occurrence, clipId: "clip_host_full" };
    const lane = sampleTrack({
      has_source_audio: true,
      duration_sec: 10,
      range_media_seal: "same-media",
    });
    const original = { ...project([]), tracks: [lane] };
    replaceProject(original);
    const { session, selected } = harness(implicit);
    const ticket = session.beginRestore(await selected())!;
    const materialized = {
      ...project([clip({ id: implicit.clipId, source_id: null })]),
      tracks: [lane],
    };
    const acknowledged = {
      ...materialized,
      history: { ...materialized.history, head_id: head },
    };
    replaceProject(acknowledged);
    replaceProject({ ...original, history: acknowledged.history });
    replaceProject(acknowledged);
    expect(
      session.finishRestore(ticket, {
        status: "acknowledged",
        historyHead: head,
      }),
    ).toBe(false);
    expect(session.getSnapshot()).toBeNull();
  });

  it("cannot revive pending Restore Undo after an intervening peer head", async () => {
    const { session, selected } = harness();
    const ticket = session.beginRestore(await selected())!;
    setHead(peerHead);
    setHead(head);
    const accepted = session.finishRestore(ticket, {
      status: "acknowledged",
      historyHead: head,
    });
    const receipt = session.getSnapshot()?.undo;
    expect(accepted).toBe(false);
    expect(receipt ?? null).toBeNull();
  });

  it("cannot revive pending Restore after its observed head returns to the opening head", async () => {
    const { session, selected } = harness();
    const ticket = session.beginRestore(await selected())!;
    setHead(peerHead);
    setHead(HISTORY_ROOT_ID);
    expect(
      session.finishRestore(ticket, {
        status: "acknowledged",
        historyHead: HISTORY_ROOT_ID,
      }),
    ).toBe(false);
    expect(session.getSnapshot()).toBeNull();
  });

  it("counts own head observation and its displayed projection as one transition", async () => {
    const { session, selected } = harness();
    const captured = await selected();
    const ticket = session.beginRestore(captured)!;
    noteOwnCommandHead(captured.scope, {
      seq: 1,
      head,
      displayedFrom: HISTORY_ROOT_ID,
    });
    expect(session.currentTarget()).toBeNull();
    expect(session.getSnapshot()?.action.state).toBe("saving");
    documentAuthority.seq = 1;
    setHead();
    useDawStore.setState({ playheadSec: 1 });
    expect(
      session.finishRestore(ticket, {
        status: "acknowledged",
        historyHead: head,
      }),
    ).toBe(true);
    const receipt = session.getSnapshot()!.undo!;
    expect(receipt.expectedHeadId).toBe(head);
    expect(session.currentUndo(receipt)).toBe(true);
  });

  it("retires a pending Restore after its own head is followed by a peer head", async () => {
    const { session, selected } = harness();
    const captured = await selected();
    const ticket = session.beginRestore(captured)!;
    noteOwnCommandHead(captured.scope, {
      seq: 1,
      head,
      displayedFrom: HISTORY_ROOT_ID,
    });
    expect(session.currentTarget()).toBeNull();
    setHead(peerHead);
    setHead(head);
    expect(
      session.finishRestore(ticket, {
        status: "acknowledged",
        historyHead: head,
      }),
    ).toBe(false);
    expect(session.getSnapshot()).toBeNull();
  });

  it("retires explicit recording replacement while Restore waits", async () => {
    const { session, selected } = harness();
    const ticket = session.beginRestore(await selected())!;
    replaceProject(project([clip({ recording_key: "replacement" })]));
    expect(
      session.finishRestore(ticket, {
        status: "acknowledged",
        historyHead: head,
      }),
    ).toBe(false);
    expect(session.getSnapshot()).toBeNull();
  });

  it("retires Undo immediately on explicit refresh", async () => {
    const { session, reads, selected } = harness();
    const ticket = session.beginRestore(await selected())!;
    setHead();
    session.finishRestore(ticket, {
      status: "acknowledged",
      historyHead: head,
    });
    const receipt = session.getSnapshot()!.undo!;
    const refresh = session.refresh();
    expect(session.currentUndo(receipt)).toBe(false);
    expect(session.beginUndo(receipt)).toBeNull();
    reads.at(-1)!.response.resolve(inspection());
    await refresh;
    expect(session.currentUndo(receipt)).toBe(false);
  });

  it("cannot revive Undo receipt after peer head leaves and returns", async () => {
    const { session, selected } = harness();
    const ticket = session.beginRestore(await selected())!;
    setHead();
    session.finishRestore(ticket, {
      status: "acknowledged",
      historyHead: head,
    });
    const receipt = session.getSnapshot()!.undo!;
    setHead(peerHead);
    setHead(head);
    expect(session.currentUndo(receipt)).toBe(false);
  });
});
