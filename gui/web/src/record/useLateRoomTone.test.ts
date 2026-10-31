import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import type { RoomToneStatus } from "./roomTone";
import type { RecordSnapshot } from "./types";
import {
  memoryUploadTransport,
  type RecordUploadStatus,
} from "./upload/transport";
import { useLateRoomTone } from "./useLateRoomTone";

const me = recordParticipant({ participant_id: "p_late" });
const snap = (over: Partial<RecordSnapshot> = {}) =>
  recordSnapshot({
    state: "lobby",
    room_tone: {
      round: 1,
      requested_wall_ms: 1000,
      duration_ms: 60_000,
      participant_ids: ["p_early"],
    },
    countdown_left_ms: 0,
    participants: [me],
    ...over,
  });

type Props = {
  snapshot?: RecordSnapshot | null;
  status?: RoomToneStatus;
  producer?: boolean;
  captureReady?: boolean;
  transport?: ReturnType<typeof memoryUploadTransport> | null;
  error?: string | null;
};

function setup(initial: Props = {}) {
  const record = vi.fn();
  const skip = vi.fn();
  const base = memoryUploadTransport();
  const transport = { ...base };
  const view = renderHook(
    (props: Props) =>
      useLateRoomTone({
        snapshot: props.snapshot === undefined ? snap() : props.snapshot,
        me,
        producer: props.producer ?? false,
        transport: props.transport === undefined ? transport : props.transport,
        roomTone: {
          status: props.status ?? "idle",
          error: props.error ?? null,
          captureReady: props.captureReady ?? true,
          record,
          skip,
        },
      }),
    { initialProps: initial },
  );
  return { record, skip, transport, ...view };
}

describe("useLateRoomTone", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.useRealTimers());

  it("offers Record room tone and Skip to a late guest, wired to the shared capture", async () => {
    const { result, record, skip } = setup();
    await waitFor(() => expect(result.current?.kind).toBe("room-tone"));
    result.current?.onAction?.();
    result.current?.onSecondaryAction?.();
    expect(record).toHaveBeenCalledOnce();
    expect(skip).toHaveBeenCalledOnce();
  });

  it("stays quiet for a guest the countdown named", async () => {
    const { result } = setup({
      snapshot: snap({
        room_tone: {
          round: 1,
          requested_wall_ms: 1000,
          duration_ms: 60_000,
          participant_ids: ["p_early", "p_late"],
        },
      }),
    });
    await act(async () => {});
    expect(result.current).toBeNull();
  });

  it.each(["recording", "paused"] as const)(
    "stays quiet while a take is %s and returns after Stop",
    async (state) => {
      const { result, rerender } = setup({ snapshot: snap({ state }) });
      await act(async () => {});
      expect(result.current).toBeNull();
      rerender({ snapshot: snap({ state: "stopped", take_index: 0 }) });
      await waitFor(() => expect(result.current?.kind).toBe("room-tone"));
    },
  );

  it("stays quiet for a producer and while capture is not ready", async () => {
    const producer = setup({ producer: true });
    const notReady = setup({ captureReady: false });
    await act(async () => {});
    expect(producer.result.current).toBeNull();
    expect(notReady.result.current).toBeNull();
  });

  it("waits out a countdown still running when the guest joins", async () => {
    vi.useFakeTimers();
    const { result } = setup({ snapshot: snap({ countdown_left_ms: 2000 }) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(result.current?.kind).toBe("room-tone");
  });

  it("hands the alert slot to the capturing row while a take runs, then nothing once recorded", async () => {
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current?.onAction).toBeDefined());
    rerender({ status: "capturing" });
    expect(result.current).toBeNull();
    rerender({ status: "recorded" });
    expect(result.current).toBeNull();
  });

  it("says a take ended too early was too short and offers another try", async () => {
    const { result } = setup({ status: "too_short" });
    await waitFor(() =>
      expect(result.current?.message).toBe(
        "Too short, record at least 10 seconds",
      ),
    );
    expect(result.current?.onAction).toBeDefined();
    expect(result.current?.onSecondaryAction).toBeDefined();
  });

  it("says so and offers another try when the bed was too loud or failed", async () => {
    const { result, rerender } = setup({ status: "too_loud" });
    await waitFor(() =>
      expect(result.current?.message).toBe("Too loud: is something playing?"),
    );
    expect(result.current?.onAction).toBeDefined();
    rerender({ status: "error", error: "upload failed" });
    expect(result.current?.message).toBe("upload failed");
    expect(result.current?.onAction).toBeDefined();
  });

  it("does not ask again after a skip, and not after a reload either", async () => {
    const first = setup();
    await waitFor(() => expect(first.result.current).not.toBeNull());
    first.rerender({ status: "skipped" });
    expect(first.result.current).toBeNull();
    first.unmount();
    const reloaded = setup();
    await act(async () => {});
    expect(reloaded.result.current).toBeNull();
  });

  it("does not ask again after a recorded bed, even before the host acknowledged it", async () => {
    const first = setup();
    await waitFor(() => expect(first.result.current).not.toBeNull());
    first.rerender({ status: "recorded" });
    first.unmount();
    const reloaded = setup();
    await act(async () => {});
    expect(reloaded.result.current).toBeNull();
  });

  const withStatus = (status: () => Promise<RecordUploadStatus>) => ({
    ...memoryUploadTransport(),
    status,
  });

  it("asks again after a recorded bed the host could not save, even on the device that recorded it", async () => {
    const failed = withStatus(async () => ({
      segments: [],
      room_tone_status: [
        { participant_id: "p_late", file_ack: true, land_failed: true },
      ],
    }));
    const first = setup({ transport: failed });
    await waitFor(() => expect(first.result.current).not.toBeNull());
    first.rerender({ status: "recorded" });
    first.unmount();
    const reloaded = setup({ transport: failed });
    await waitFor(() =>
      expect(reloaded.result.current?.kind).toBe("room-tone"),
    );
  });

  it("does not ask again after a recorded bed when the host status cannot be read", async () => {
    const first = setup();
    await waitFor(() => expect(first.result.current).not.toBeNull());
    first.rerender({ status: "recorded" });
    first.unmount();
    const reloaded = setup({
      transport: withStatus(async () => {
        throw new Error("offline");
      }),
    });
    await act(async () => {});
    expect(reloaded.result.current).toBeNull();
  });

  it("trusts the host's upload status when this device forgot", async () => {
    const { result } = setup({
      transport: withStatus(async () => ({
        segments: [],
        room_tone_status: [{ participant_id: "p_late", file_ack: true }],
      })),
    });
    await act(async () => {});
    expect(result.current).toBeNull();
  });

  it("asks when the host has no acknowledged bed for the guest", async () => {
    const { result } = setup({
      transport: withStatus(async () => ({
        segments: [],
        room_tone_status: [{ participant_id: "p_late", file_ack: false }],
      })),
    });
    await waitFor(() => expect(result.current?.kind).toBe("room-tone"));
  });

  it("asks again when the host received the bed but could not save it", async () => {
    const { result } = setup({
      transport: withStatus(async () => ({
        segments: [],
        room_tone_status: [
          { participant_id: "p_late", file_ack: true, land_failed: true },
        ],
      })),
    });
    await waitFor(() => expect(result.current?.kind).toBe("room-tone"));
  });

  it("asks when the host's status cannot be read", async () => {
    const { result } = setup({
      transport: withStatus(async () => {
        throw new Error("offline");
      }),
    });
    await waitFor(() => expect(result.current?.kind).toBe("room-tone"));
  });

  it("does not flash the prompt while the host's status is still loading", async () => {
    const { result } = setup({
      transport: withStatus(() => new Promise(() => {})),
    });
    await act(async () => {});
    expect(result.current).toBeNull();
  });
});
