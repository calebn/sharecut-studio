import { describe, expect, it } from "vitest";
import {
  emitRecordSignal,
  isRecordSignal,
  subscribeRecordSignal,
} from "./signalBus";

const offer = {
  type: "Signal" as const,
  from: "A",
  to: "B",
  description: { type: "offer" as const, sdp: "v=0" },
};

describe("record signal bus", () => {
  it("delivers addressed Signal frames to subscribers", () => {
    const got: string[] = [];
    const stop = subscribeRecordSignal((msg) => {
      got.push(`${msg.from}->${msg.to}`);
    });
    emitRecordSignal(offer);
    emitRecordSignal({ type: "Signal", from: "", to: "B" });
    emitRecordSignal({ type: "Signal", from: "A", to: "B" });
    expect(got).toEqual(["A->B"]);
    stop();
    const late: string[] = [];
    const stopLate = subscribeRecordSignal((msg) => {
      late.push(`${msg.from}->${msg.to}`);
    });
    emitRecordSignal({
      type: "Signal",
      from: "A",
      to: "C",
      candidate: { candidate: "x" },
    });
    expect(got).toEqual(["A->B"]);
    expect(late).toEqual(["A->C"]);
    stopLate();
    expect(isRecordSignal({ ...offer, plane: "record" })).toBe(true);
    expect(isRecordSignal({ type: "Echo" })).toBe(false);
    expect(isRecordSignal({ type: "Signal", from: "A", to: "B" })).toBe(false);
  });

  it("replays per-peer signals that arrived before a subscriber attached", () => {
    const got: string[] = [];
    emitRecordSignal(offer);
    emitRecordSignal({
      type: "Signal",
      from: "C",
      to: "B",
      candidate: { candidate: "ice" },
    });
    const stop = subscribeRecordSignal((msg) => {
      got.push(`${msg.from}->${msg.to}`);
    });
    expect(got).toEqual(["A->B", "C->B"]);
    stop();
  });
});
