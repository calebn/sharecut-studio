import { describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { enqueueInbound, pendingInboundCount } from "../sync/inboundQueue";
import { minimalProject } from "../test/fixtures";
import { documentClientId } from "../utils/documentClient";
import { MAX_CONTENT_PX } from "../utils/timelineZoom.generated";
import {
  applyDocumentResult,
  applyDocumentSnapshot,
  applyDocumentSnapshotWithResync,
} from "./applyDocumentUpdate";
import {
  noteDocumentFile,
  noteDocumentSeq,
  pollSnapshotAlreadyApplied,
  resetDocumentSeqForTests,
} from "./cursor";

const track = (id: string) => ({
  id,
  label: id,
  role: "dialogue" as const,
  speaker: null,
  gain_db: 0,
  muted: false,
  duration_sec: 1,
  fx_count: 0,
  stem_is_fresh: true,
});

describe("applyDocumentSnapshot", () => {
  it("reclamps zoom to the new session length in the same update", () => {
    resetDocumentSeqForTests();
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ timeline_duration_sec: 60 }));
    useDawStore.setState({ zoomPxPerSec: 48000, scrollLeft: 0 });
    applyDocumentSnapshot({
      server_seq: 9,
      project: minimalProject({ timeline_duration_sec: 3600 }),
    });
    expect(useDawStore.getState().zoomPxPerSec).toBeLessThanOrEqual(
      MAX_CONTENT_PX / 3600 + 1e-9,
    );
  });

  it("merges a second non-echo apply at the same seq", () => {
    resetDocumentSeqForTests();
    const first = minimalProject({ tracks: [] });
    useDawStore.getState().hydrate("/tmp/p.json", first);
    applyDocumentSnapshot({
      server_seq: 3,
      patch: { tracks: [track("a")] },
    });
    expect(useDawStore.getState().project?.tracks).toHaveLength(1);
    applyDocumentSnapshot({
      server_seq: 3,
      project: minimalProject({ tracks: [track("b")] }),
    });
    expect(useDawStore.getState().project?.tracks[0]?.id).toBe("b");
  });

  it("skips own-client Applied at the current seq", () => {
    resetDocumentSeqForTests();
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ tracks: [] }));
    applyDocumentSnapshot({
      server_seq: 3,
      patch: { tracks: [track("a")] },
    });
    applyDocumentSnapshot(
      {
        server_seq: 3,
        project: minimalProject({ tracks: [track("own")] }),
      },
      { commandClientId: documentClientId() },
    );
    expect(useDawStore.getState().project?.tracks[0]?.id).toBe("a");
  });

  it("keeps the newer envelope by identity when a stale peer snapshot races an own HTTP apply", () => {
    resetDocumentSeqForTests();
    const env = (value: number) => ({
      track_id: "host",
      parameter: "volume",
      points: [{ id: "p1", time: 0, value }],
    });
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ envelopes: [env(1)] }));
    // The own HTTP command result lands first, at seq 5.
    applyDocumentSnapshot(
      { server_seq: 5, project: minimalProject({ envelopes: [env(1.5)] }) },
      { commandClientId: documentClientId() },
    );
    const newer = useDawStore.getState().project!.envelopes[0];
    expect(newer?.points[0]?.value).toBe(1.5);
    // A peer snapshot from before that command arrives late over WS.
    applyDocumentSnapshot(
      { server_seq: 4, project: minimalProject({ envelopes: [env(1)] }) },
      { commandClientId: "peer-client" },
    );
    expect(useDawStore.getState().project!.envelopes[0]).toBe(newer);
    // The WS echo of the own command at the same seq is skipped.
    applyDocumentSnapshot(
      { server_seq: 5, project: minimalProject({ envelopes: [env(1.5)] }) },
      { commandClientId: documentClientId() },
    );
    expect(useDawStore.getState().project!.envelopes[0]).toBe(newer);
    // A peer update at the current seq with equal content applies, and
    // reuseUnchanged keeps the envelope's identity.
    applyDocumentSnapshot(
      { server_seq: 5, project: minimalProject({ envelopes: [env(1.5)] }) },
      { commandClientId: "peer-client" },
    );
    expect(useDawStore.getState().project!.envelopes[0]).toBe(newer);
  });

  it("refetches shell when snapshot.resync is set", async () => {
    resetDocumentSeqForTests();
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ tracks: [track("stale")] }));
    const shell = minimalProject({ tracks: [track("fresh")] });
    await applyDocumentSnapshotWithResync(
      {
        server_seq: 4,
        resync: true,
        patch: { clips: { tracks: {}, clip_count: 0 } },
      },
      async () => shell,
    );
    expect(useDawStore.getState().project?.tracks[0]?.id).toBe("fresh");
  });
});

describe("applyDocumentResult", () => {
  it("records the result's file so the poll skips this client's own edit, before or after the WS echo", () => {
    resetDocumentSeqForTests();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    noteDocumentSeq(1);
    noteDocumentFile({ project: {}, file: { mtime_ns: 100, size: 5 } });
    const snapshot = {
      server_seq: 2,
      comments: [],
      file_before: { mtime_ns: 100, size: 5 },
      file: { mtime_ns: 200, size: 6 },
    };
    applyDocumentResult({
      command: { client_id: documentClientId() },
      snapshot,
    });
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 200, size: 6, server_seq: 2 }),
    ).toBe(true);
    // The WS echo of the same commit arrives afterwards.
    noteDocumentFile(snapshot);
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 200, size: 6, server_seq: 2 }),
    ).toBe(true);
  });

  it("flushes any queued inbound frame before applying its own result", () => {
    resetDocumentSeqForTests();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    const order: string[] = [];
    enqueueInbound(() => order.push("queued-peer-frame"));
    expect(pendingInboundCount()).toBe(1);
    applyDocumentResult({
      command: { client_id: documentClientId() },
      snapshot: { server_seq: 1, comments: [] },
    });
    order.push("own-result-applied");
    expect(order).toEqual(["queued-peer-frame", "own-result-applied"]);
    expect(pendingInboundCount()).toBe(0);
  });
});
