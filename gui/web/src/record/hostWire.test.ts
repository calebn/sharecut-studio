import { afterEach, describe, expect, it, vi } from "vitest";
import { bindWsSender } from "../session/wsSend";
import {
  bindRecordHostSend,
  nextHostRecordClientSeq,
  sendRecordHostCommand,
} from "./hostWire";
import { commentsQueueKey, postLiveComment } from "./liveCommentQueue";

describe("hostWire", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("propagates a bound socket refusal through Notes", () => {
    const transportWrites: string[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: (frame: string) => transportWrites.push(frame),
    } as unknown as WebSocket;
    bindRecordHostSend(bindWsSender(socket));
    socket.readyState = WebSocket.CLOSING;

    expect(sendRecordHostCommand("Comment", { body: "Still bound" })).toBe(
      false,
    );
    expect(transportWrites).toEqual([]);

    const key = commentsQueueKey("host-refusal");
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      storageKey: string,
      value: string,
    ) {
      if (storageKey === key) {
        throw new Error("synthetic comments queue refusal");
      }
      originalSetItem.call(this, storageKey, value);
    });
    expect(
      postLiveComment(sendRecordHostCommand, "host-refusal", {
        body: "Retain this note",
        takeIndex: 2,
        recordingMs: 1200,
        author: "host",
      }),
    ).toBeNull();
    expect(transportWrites).toEqual([]);
  });

  it("accepts Notes when either the queue or an open legacy sender accepts", () => {
    const closedSocket = {
      readyState: WebSocket.CLOSED,
      send: () => {
        throw new Error("closed socket must not write");
      },
    } as unknown as WebSocket;
    bindRecordHostSend(bindWsSender(closedSocket));
    expect(
      postLiveComment(sendRecordHostCommand, "host-queued", {
        body: "Queued note",
        takeIndex: 2,
        recordingMs: 1200,
        author: "host",
      }),
    ).not.toBeNull();

    const openSocket = {
      readyState: WebSocket.OPEN,
      send: () => undefined,
    } as unknown as WebSocket;
    bindRecordHostSend(bindWsSender(openSocket));
    const key = commentsQueueKey("host-transport");
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      storageKey: string,
      value: string,
    ) {
      if (storageKey === key) {
        throw new Error("synthetic comments queue refusal");
      }
      originalSetItem.call(this, storageKey, value);
    });
    expect(
      postLiveComment(sendRecordHostCommand, "host-transport", {
        body: "Transport accepted note",
        takeIndex: 2,
        recordingMs: 1200,
        author: "host",
      }),
    ).not.toBeNull();
  });

  it("treats legacy callback returns as accepted and propagates throws", () => {
    bindRecordHostSend(() => undefined);
    expect(sendRecordHostCommand("Comment")).toBe(true);

    const sent: Record<string, unknown>[] = [];
    bindRecordHostSend((frame) => sent.push(frame));
    expect(sendRecordHostCommand("Comment")).toBe(true);
    expect(sent).toHaveLength(1);

    bindRecordHostSend(() => {
      throw new Error("sender failed");
    });
    expect(() => sendRecordHostCommand("Comment")).toThrow("sender failed");
  });
});
