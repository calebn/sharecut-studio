import { describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { documentClientId } from "../utils/documentClient";
import { MAX_CONTENT_PX } from "../utils/timelineZoom.generated";
import {
  applyDocumentSnapshot,
  applyDocumentSnapshotWithResync,
} from "./applyDocumentUpdate";
import { resetDocumentSeqForTests } from "./cursor";

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
