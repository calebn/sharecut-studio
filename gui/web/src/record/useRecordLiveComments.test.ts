import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import {
  enqueueComment,
  loadCommentQueue,
  MARKER_BODY,
} from "./liveCommentQueue";
import type { RecordSnapshot } from "./types";
import { useRecordLiveComments } from "./useRecordLiveComments";

const me = recordParticipant({
  participant_id: "p_g",
  display_name: "Ava",
});

const recording = recordSnapshot({
  session_id: "room1",
  recording_ms: 1500,
  participants: [me],
  comments: [],
});

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

  it("refuses a note when neither storage nor transport accepts it", () => {
    const send = vi.fn(() => false);
    const { result } = renderHook(() =>
      useRecordLiveComments({
        token: "tok",
        snapshot: recording,
        me,
        connected: true,
        send,
      }),
    );
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    try {
      expect(result.current.postNote("Keep this draft")).toBe(false);
      expect(loadCommentQueue("tok")).toEqual([]);
      expect(send).toHaveBeenCalledWith(
        "Comment",
        expect.objectContaining({ body: "Keep this draft" }),
      );
    } finally {
      setItem.mockRestore();
    }
  });

  it.each([
    { queued: true, sent: false, label: "durable offline queue" },
    { queued: false, sent: true, label: "transport without storage" },
    {
      queued: false,
      sent: undefined,
      label: "legacy void sender without storage",
    },
  ])("accepts a note through $label", ({ queued, sent }) => {
    const send = vi.fn(() => sent);
    const { result } = renderHook(() =>
      useRecordLiveComments({
        token: "tok",
        snapshot: recording,
        me,
        connected: true,
        send,
      }),
    );
    const setItem = queued
      ? null
      : vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new Error("quota");
        });
    try {
      expect(result.current.postNote("Keep this note")).toBe(true);
      expect(loadCommentQueue("tok")).toHaveLength(queued ? 1 : 0);
      expect(send).toHaveBeenCalledWith(
        "Comment",
        expect.objectContaining({ body: "Keep this note" }),
      );
    } finally {
      setItem?.mockRestore();
    }
  });

  it("routes a retained posting command to the committed sender", () => {
    const previous = vi.fn(() => true);
    const current = vi.fn(() => true);
    const { result, rerender } = renderHook(
      ({ send }) =>
        useRecordLiveComments({
          token: "tok",
          snapshot: recording,
          me,
          connected: true,
          send,
        }),
      { initialProps: { send: previous } },
    );
    const postMarker = result.current.postMarker;
    rerender({ send: current });
    act(() => postMarker());
    expect(previous).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledExactlyOnceWith(
      "Comment",
      expect.objectContaining({ body: MARKER_BODY, author: "p_g" }),
    );
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
