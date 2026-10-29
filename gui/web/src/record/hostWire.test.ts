import { afterEach, describe, expect, it } from "vitest";
import {
  bindRecordHostSend,
  nextHostRecordClientSeq,
  sendRecordHostCommand,
} from "./hostWire";

describe("hostWire", () => {
  afterEach(() => {
    sessionStorage.clear();
    bindRecordHostSend(null);
  });

  it("persists client_seq across reloads", () => {
    expect(nextHostRecordClientSeq()).toBe(1);
    expect(nextHostRecordClientSeq()).toBe(2);
    const sent: Record<string, unknown>[] = [];
    bindRecordHostSend((frame) => {
      sent.push(frame);
    });
    sendRecordHostCommand("Start");
    expect(sent[0]?.client_seq).toBe(3);
    sendRecordHostCommand("Comment", { id: "m1", body: "Marker" });
    expect(sent[1]?.command_id).toBeUndefined();
    expect(sent[1]?.command_type).toBe("Comment");
    expect(sent[1]?.payload).toEqual({ id: "m1", body: "Marker" });
  });

  it("sends a segment report as a Record frame", () => {
    const sent: Record<string, unknown>[] = [];
    bindRecordHostSend((frame) => {
      sent.push(frame);
    });
    sendRecordHostCommand("SegmentReport", {
      take_index: 0,
      segments: 2,
      final: true,
    });
    expect(sent[0]).toMatchObject({
      type: "Record",
      command_type: "SegmentReport",
      payload: { take_index: 0, segments: 2, final: true },
    });
  });

  it("returns false when the host socket is unbound", () => {
    expect(sendRecordHostCommand("Comment")).toBe(false);
  });
});
