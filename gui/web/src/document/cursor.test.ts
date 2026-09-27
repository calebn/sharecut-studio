import { describe, expect, it } from "vitest";
import { documentClientId } from "../utils/documentClient";
import {
  currentDocumentSeq,
  noteDocumentFile,
  noteDocumentSeq,
  notePolledDocumentFile,
  pollSnapshotAlreadyApplied,
  resetDocumentSeqForTests,
  shouldApplyDocumentEvent,
  shouldApplyPollSnapshot,
} from "./cursor";

describe("document cursor", () => {
  it("applies peer snapshots at the current seq", () => {
    resetDocumentSeqForTests();
    noteDocumentSeq(3);
    expect(
      shouldApplyDocumentEvent({
        server_seq: 3,
        snapshot: { server_seq: 3 },
      }),
    ).toBe(true);
  });

  it("skips strictly older seq", () => {
    resetDocumentSeqForTests();
    noteDocumentSeq(3);
    expect(
      shouldApplyDocumentEvent({
        server_seq: 2,
        snapshot: { server_seq: 2 },
      }),
    ).toBe(false);
  });

  it("skips own-HTTP Applied at the current seq", () => {
    resetDocumentSeqForTests();
    noteDocumentSeq(3);
    const own = documentClientId();
    expect(
      shouldApplyDocumentEvent({
        server_seq: 3,
        command: { client_id: own },
      }),
    ).toBe(false);
  });

  it("applies hub resync even for own-client seq", () => {
    resetDocumentSeqForTests();
    noteDocumentSeq(3);
    const own = documentClientId();
    expect(
      shouldApplyDocumentEvent({
        server_seq: 3,
        snapshot: { server_seq: 3, resync: true },
        command: { client_id: own },
      }),
    ).toBe(true);
  });

  it("resets seq so a new project is not gated on the previous tab", () => {
    resetDocumentSeqForTests();
    noteDocumentSeq(40);
    expect(currentDocumentSeq()).toBe(40);
    resetDocumentSeqForTests();
    expect(currentDocumentSeq()).toBe(0);
    expect(shouldApplyDocumentEvent({ server_seq: 3 })).toBe(true);
  });

  it("reloads poll snapshots when seq is equal or zero", () => {
    expect(shouldApplyPollSnapshot(0, 0)).toBe(true);
    expect(shouldApplyPollSnapshot(5, 5)).toBe(true);
    expect(shouldApplyPollSnapshot(6, 5)).toBe(true);
    expect(shouldApplyPollSnapshot(5, 6)).toBe(false);
  });
});

describe("document file signature", () => {
  it("matches a project snapshot's file to a meta at the same or later seq", () => {
    resetDocumentSeqForTests();
    noteDocumentSeq(3);
    noteDocumentFile({ project: {}, file: { mtime_ns: 100, size: 5 } });
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 100, size: 5, server_seq: 3 }),
    ).toBe(true);
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 100, size: 5, server_seq: 2 }),
    ).toBe(true);
  });

  it("is false when meta seq is greater than the applied seq", () => {
    resetDocumentSeqForTests();
    noteDocumentSeq(3);
    noteDocumentFile({ project: {}, file: { mtime_ns: 100, size: 5 } });
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 100, size: 5, server_seq: 4 }),
    ).toBe(false);
  });

  it("is false on a different mtime, size, or an undefined size", () => {
    resetDocumentSeqForTests();
    noteDocumentSeq(3);
    noteDocumentFile({ project: {}, file: { mtime_ns: 100, size: 5 } });
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 101, size: 5, server_seq: 3 }),
    ).toBe(false);
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 100, size: 6, server_seq: 3 }),
    ).toBe(false);
    expect(pollSnapshotAlreadyApplied({ mtime_ns: 100, server_seq: 3 })).toBe(
      false,
    );
  });

  it("advances the file through a patch whose file_before chains", () => {
    resetDocumentSeqForTests();
    noteDocumentSeq(1);
    noteDocumentFile({ project: {}, file: { mtime_ns: 100, size: 5 } });
    noteDocumentSeq(2);
    noteDocumentFile({
      file_before: { mtime_ns: 100, size: 5 },
      file: { mtime_ns: 200, size: 6 },
    });
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 200, size: 6, server_seq: 2 }),
    ).toBe(true);
  });

  it("marks the file unknown on a mismatched or missing file_before, or resync", () => {
    resetDocumentSeqForTests();
    noteDocumentFile({ project: {}, file: { mtime_ns: 100, size: 5 } });
    noteDocumentFile({
      file_before: { mtime_ns: 999, size: 9 },
      file: { mtime_ns: 200, size: 6 },
    });
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 200, size: 6, server_seq: 0 }),
    ).toBe(false);

    noteDocumentFile({ project: {}, file: { mtime_ns: 100, size: 5 } });
    // comments-projection patch: no file_before at all.
    noteDocumentFile({ file: { mtime_ns: 200, size: 6 } });
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 200, size: 6, server_seq: 0 }),
    ).toBe(false);

    noteDocumentFile({ project: {}, file: { mtime_ns: 100, size: 5 } });
    noteDocumentFile({ resync: true, file: { mtime_ns: 200, size: 6 } });
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 100, size: 5, server_seq: 0 }),
    ).toBe(false);
  });

  it("notePolledDocumentFile records the poll's own file, or clears it", () => {
    resetDocumentSeqForTests();
    noteDocumentSeq(5);
    notePolledDocumentFile({ mtime_ns: 300, size: 7 });
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 300, size: 7, server_seq: 5 }),
    ).toBe(true);
    notePolledDocumentFile({ mtime_ns: 400 });
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 400, size: 8, server_seq: 5 }),
    ).toBe(false);
  });

  it("reset clears the file", () => {
    noteDocumentSeq(1);
    noteDocumentFile({ project: {}, file: { mtime_ns: 1, size: 1 } });
    resetDocumentSeqForTests();
    expect(pollSnapshotAlreadyApplied({ mtime_ns: 1, size: 1 })).toBe(false);
  });

  it("keeps the held file when a snapshot announces it again", () => {
    resetDocumentSeqForTests();
    noteDocumentSeq(2);
    noteDocumentFile({ project: {}, file: { mtime_ns: 100, size: 5 } });
    noteDocumentFile({
      file_before: { mtime_ns: 50, size: 4 },
      file: { mtime_ns: 100, size: 5 },
    });
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 100, size: 5, server_seq: 2 }),
    ).toBe(true);
  });
});
