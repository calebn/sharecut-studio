import { describe, expect, it } from "vitest";
import { documentClientId } from "../utils/documentClient";
import {
  currentDocumentSeq,
  noteDocumentSeq,
  resetDocumentSeqForTests,
  shouldApplyDocumentEvent,
  shouldApplyPollSnapshot,
} from "./cursor";

describe("document cursor", () => {
  it("applies non-echo snapshots at the current seq", () => {
    resetDocumentSeqForTests();
    noteDocumentSeq(3);
    expect(
      shouldApplyDocumentEvent({
        type: "Applied",
        server_seq: 3,
        snapshot: { server_seq: 3 },
      }),
    ).toBe(true);
  });

  it("skips strictly older seq and Echo", () => {
    resetDocumentSeqForTests();
    noteDocumentSeq(3);
    expect(
      shouldApplyDocumentEvent({
        type: "Applied",
        server_seq: 2,
        snapshot: { server_seq: 2 },
      }),
    ).toBe(false);
    expect(
      shouldApplyDocumentEvent({
        type: "Echo",
        server_seq: 4,
        snapshot: { server_seq: 4 },
      }),
    ).toBe(false);
  });

  it("skips own-HTTP Applied at the current seq", () => {
    resetDocumentSeqForTests();
    noteDocumentSeq(3);
    const own = documentClientId();
    expect(
      shouldApplyDocumentEvent({
        type: "Applied",
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
        type: "Applied",
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
    expect(shouldApplyDocumentEvent({ type: "Applied", server_seq: 3 })).toBe(
      true,
    );
  });

  it("reloads poll snapshots when seq is equal or zero", () => {
    expect(shouldApplyPollSnapshot(0, 0)).toBe(true);
    expect(shouldApplyPollSnapshot(5, 5)).toBe(true);
    expect(shouldApplyPollSnapshot(6, 5)).toBe(true);
    expect(shouldApplyPollSnapshot(5, 6)).toBe(false);
  });
});
