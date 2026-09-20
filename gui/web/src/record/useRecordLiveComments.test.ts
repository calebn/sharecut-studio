import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueueComment,
  loadCommentQueue,
  MARKER_BODY,
} from "./liveCommentQueue";
import type { RecordParticipant, RecordSnapshot } from "./types";
import { useRecordLiveComments } from "./useRecordLiveComments";

const me: RecordParticipant = {
  participant_id: "p_g",
  role: "guest",
  display_name: "Ava",
  connected: true,
  consented: true,
  muted: false,
  headphones_ack: true,
};

const recording: RecordSnapshot = {
  session_id: "room1",
  state: "recording",
  take_index: 0,
  recording_ms: 1500,
  participants: [me],
  caps: { recorded: 4, producers: 2 },
  comments: [],
};

describe("useRecordLiveComments", () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it("sends Marker and queues while disconnected", () => {
    const send = vi.fn(() => true);
    const { result } = renderHook(() =>
      useRecordLiveComments({
        token: "tok",
        snapshot: recording,
        me,
        connected: true,
        send,
      }),
    );
    act(() => {
      result.current.postMarker();
    });
    expect(send).toHaveBeenCalledWith(
      "Comment",
      expect.objectContaining({ body: MARKER_BODY, author: "p_g" }),
    );
    expect(loadCommentQueue("tok")).toHaveLength(1);
    expect(loadCommentQueue("tok")[0]?.id.startsWith("live-")).toBe(true);

    send.mockReturnValue(false);
    act(() => {
      result.current.setNote("hold for laugh");
    });
    act(() => {
      result.current.submitNote();
    });
    expect(loadCommentQueue("tok")).toHaveLength(2);
    expect(
      loadCommentQueue("tok").some((row) => row.body === "hold for laugh"),
    ).toBe(true);
  });

  it("flushes the reconnect queue once the snapshot acks the id", () => {
    const send = vi.fn(() => true);
    enqueueComment("tok", {
      id: "live-queued-1",
      take_index: 0,
      recording_ms: 10,
      pressed_wall_ms: 10,
      author: "p_g",
      body: "Marker",
    });
    const { rerender } = renderHook(
      (props: { snap: RecordSnapshot }) =>
        useRecordLiveComments({
          token: "tok",
          snapshot: props.snap,
          me,
          connected: true,
          send,
        }),
      { initialProps: { snap: recording } },
    );
    expect(send).toHaveBeenCalledWith(
      "Comment",
      expect.objectContaining({ id: "live-queued-1" }),
    );
    expect(loadCommentQueue("tok")).toHaveLength(1);
    rerender({
      snap: {
        ...recording,
        comments: [
          {
            id: "live-queued-1",
            take_index: 0,
            recording_ms: 10,
            pressed_wall_ms: 10,
            author: "p_g",
            body: "Marker",
          },
        ],
      },
    });
    expect(loadCommentQueue("tok")).toEqual([]);
  });

  it("posts Marker from captureKeys and ignores typing targets", () => {
    const send = vi.fn(() => true);
    renderHook(() =>
      useRecordLiveComments({
        token: "tok",
        snapshot: recording,
        me,
        connected: true,
        send,
        captureKeys: true,
      }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "M", bubbles: true }),
    );
    expect(send).toHaveBeenCalledTimes(1);

    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "M", bubbles: true }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    input.remove();
  });
});
