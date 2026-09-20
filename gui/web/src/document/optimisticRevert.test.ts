import { describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { noteDocumentSeq, resetDocumentSeqForTests } from "./cursor";
import { revertOptimisticIfUnchanged } from "./optimisticRevert";

describe("revertOptimisticIfUnchanged", () => {
  it("reverts when seq has not advanced", () => {
    resetDocumentSeqForTests();
    const previous = minimalProject({ tracks: [] });
    const optimistic = minimalProject({
      tracks: [
        {
          id: "a",
          label: "A",
          role: "dialogue",
          speaker: null,
          gain_db: 0,
          muted: false,
          duration_sec: 1,
          fx_count: 0,
          stem_is_fresh: true,
        },
      ],
    });
    useDawStore.getState().hydrate("/tmp/p.json", optimistic);
    revertOptimisticIfUnchanged(previous, 0);
    expect(useDawStore.getState().project?.tracks).toHaveLength(0);
  });

  it("keeps the store when seq advanced after the optimistic splice", () => {
    resetDocumentSeqForTests();
    const previous = minimalProject({ tracks: [] });
    const peer = minimalProject({
      tracks: [
        {
          id: "peer",
          label: "Peer",
          role: "dialogue",
          speaker: null,
          gain_db: 0,
          muted: false,
          duration_sec: 1,
          fx_count: 0,
          stem_is_fresh: true,
        },
      ],
    });
    useDawStore.getState().hydrate("/tmp/p.json", peer);
    noteDocumentSeq(4);
    revertOptimisticIfUnchanged(previous, 3);
    expect(useDawStore.getState().project?.tracks[0]?.id).toBe("peer");
  });
});
