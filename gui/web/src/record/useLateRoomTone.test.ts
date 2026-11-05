import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createElement,
  StrictMode,
  Suspense,
  startTransition,
  useState,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../test/deferred";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { roomToneMarkKey, writeRoomToneMark } from "./lateRoomTone";
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
  consented?: boolean | null;
};

function setup(initial: Props = {}, wrapper?: typeof StrictMode) {
  const record = vi.fn();
  const skip = vi.fn();
  const base = memoryUploadTransport();
  const transport = { ...base };
  const view = renderHook(
    (props: Props) =>
      useLateRoomTone({
        snapshot: props.snapshot === undefined ? snap() : props.snapshot,
        me:
          props.consented === undefined
            ? me
            : { ...me, consented: props.consented },
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
    { initialProps: initial, wrapper },
  );
  return { record, skip, transport, ...view };
}

describe("useLateRoomTone", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

  describe("resolution ownership", () => {
    const key = roomToneMarkKey("sess-1", "p_late")!;

    it("trusts a skipped local mark without asking a failing host", async () => {
      writeRoomToneMark(key, "skipped");
      const status = vi.fn(async () => ({
        segments: [],
        room_tone_status: [
          { participant_id: "p_late", file_ack: true, land_failed: true },
        ],
      }));
      const { result } = setup({ transport: withStatus(status) });
      await act(async () => {});
      expect(result.current).toBeNull();
      expect(status).not.toHaveBeenCalled();
    });

    it.each(["recorded", "skipped"] as const)(
      "replaces a same-key false result after %s was persisted",
      async (status) => {
        const view = setup();
        await waitFor(() =>
          expect(view.result.current?.kind).toBe("room-tone"),
        );
        view.rerender({ status });
        expect(localStorage.getItem(key)).toBe(status);
        expect(view.result.current).toBeNull();
        const request = vi.fn(async () => ({ segments: [] }));
        view.rerender({
          status: "idle",
          transport: status === "recorded" ? null : withStatus(request),
        });
        await act(async () => {});
        expect(view.result.current).toBeNull();
        expect(request).not.toHaveBeenCalled();
      },
    );

    it("retains a visible same-key result through pending and offline rechecks", async () => {
      const view = setup();
      await waitFor(() => expect(view.result.current?.kind).toBe("room-tone"));
      const pending = deferred<RecordUploadStatus>();
      view.rerender({ transport: withStatus(() => pending.promise) });
      expect(view.result.current?.kind).toBe("room-tone");
      view.rerender({ transport: null });
      expect(view.result.current?.kind).toBe("room-tone");
      await act(async () =>
        pending.resolve({
          segments: [],
          room_tone_status: [{ participant_id: "p_late", file_ack: true }],
        }),
      );
      expect(view.result.current?.kind).toBe("room-tone");
    });

    it("retains a completed same-key result until a replacement request rejects", async () => {
      const view = setup({
        transport: withStatus(async () => ({
          segments: [],
          room_tone_status: [{ participant_id: "p_late", file_ack: true }],
        })),
      });
      await act(async () => {});
      expect(view.result.current).toBeNull();
      const pending = deferred<RecordUploadStatus>();
      view.rerender({ transport: withStatus(() => pending.promise) });
      expect(view.result.current).toBeNull();
      await act(async () => pending.reject(new Error("offline")));
      expect(view.result.current?.kind).toBe("room-tone");
    });

    it.each(["consent", "producer"] as const)(
      "keeps same-key history through %s withdrawal and a pending recheck",
      async (admission) => {
        const view = setup();
        await waitFor(() =>
          expect(view.result.current?.kind).toBe("room-tone"),
        );
        const pending = deferred<RecordUploadStatus>();
        const status = vi.fn(() => pending.promise);
        const transport = withStatus(status);
        view.rerender({
          ...(admission === "consent"
            ? { consented: false }
            : { producer: true }),
          transport,
        });
        expect(view.result.current).toBeNull();
        expect(status).not.toHaveBeenCalled();
        view.rerender({
          ...(admission === "consent"
            ? { consented: true }
            : { producer: false }),
          transport,
        });
        expect(view.result.current?.kind).toBe("room-tone");
        expect(status).toHaveBeenCalledOnce();
        await act(async () =>
          pending.resolve({
            segments: [],
            room_tone_status: [{ participant_id: "p_late", file_ack: true }],
          }),
        );
        expect(view.result.current).toBeNull();
      },
    );

    it("uses the local mark captured when the actual host request began", async () => {
      writeRoomToneMark(key, "recorded");
      const pending = deferred<RecordUploadStatus>();
      const status = vi.fn(() => pending.promise);
      const view = setup({ transport: withStatus(status) });
      expect(status).toHaveBeenCalledOnce();
      localStorage.removeItem(key);
      await act(async () => pending.resolve({ segments: [] }));
      expect(view.result.current).toBeNull();
    });

    it.each(["same-key", "new-key"] as const)(
      "rejects retired %s status resolution",
      async (scope) => {
        const pending = deferred<RecordUploadStatus>();
        const view = setup({ transport: withStatus(() => pending.promise) });
        view.rerender({
          snapshot: snap({ session_id: scope === "new-key" ? "B" : "sess-1" }),
          transport: withStatus(async () => ({ segments: [] })),
        });
        await waitFor(() =>
          expect(view.result.current?.kind).toBe("room-tone"),
        );
        await act(async () =>
          pending.resolve({
            segments: [],
            room_tone_status: [{ participant_id: "p_late", file_ack: true }],
          }),
        );
        expect(view.result.current?.kind).toBe("room-tone");
      },
    );

    it.each([false, true])(
      "keeps one result slot when the other key has published=%s",
      async (publishOther) => {
        const a = snap();
        const view = setup({ snapshot: a });
        await waitFor(() =>
          expect(view.result.current?.kind).toBe("room-tone"),
        );
        const pending = deferred<RecordUploadStatus>();
        view.rerender({
          snapshot: snap({ session_id: "B" }),
          transport: withStatus(() => pending.promise),
        });
        expect(view.result.current).toBeNull();
        if (publishOther)
          await act(async () =>
            pending.resolve({
              segments: [],
              room_tone_status: [{ participant_id: "p_late", file_ack: true }],
            }),
          );
        const next = deferred<RecordUploadStatus>();
        view.rerender({
          snapshot: a,
          transport: withStatus(() => next.promise),
        });
        expect(view.result.current?.kind ?? null).toBe(
          publishOther ? null : "room-tone",
        );
        await act(async () => next.resolve({ segments: [] }));
        expect(view.result.current?.kind).toBe("room-tone");
      },
    );

    it("replaces the countdown deadline for an equal-content new snapshot", async () => {
      vi.useFakeTimers();
      const a = snap({ countdown_left_ms: 1000 });
      const view = setup({ snapshot: a });
      await act(async () => {});
      act(() => {
        vi.advanceTimersByTime(500);
      });
      view.rerender({ snapshot: { ...a } });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(view.result.current).toBeNull();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(view.result.current?.kind).toBe("room-tone");
    });

    it("retires the first replay request without replacing the second result", async () => {
      const first = deferred<RecordUploadStatus>();
      const second = deferred<RecordUploadStatus>();
      const status = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const view = setup({ transport: withStatus(status) }, StrictMode);
      expect(status).toHaveBeenCalledTimes(2);
      await act(async () => second.resolve({ segments: [] }));
      expect(view.result.current?.kind).toBe("room-tone");
      await act(async () =>
        first.resolve({
          segments: [],
          room_tone_status: [{ participant_id: "p_late", file_ack: true }],
        }),
      );
      expect(view.result.current?.kind).toBe("room-tone");
    });

    it.each([false, true])(
      "keeps mixed-row precedence with recorded mark=%s",
      async (recorded) => {
        if (recorded) writeRoomToneMark(key, "recorded");
        const view = setup({
          transport: withStatus(async () => ({
            segments: [],
            room_tone_status: [
              { participant_id: "other", file_ack: true },
              { participant_id: "p_late", file_ack: false, land_failed: true },
              { participant_id: "p_late", file_ack: true, land_failed: true },
              { participant_id: "p_late", file_ack: true },
            ],
          })),
        });
        await act(async () => {});
        expect(view.result.current?.kind ?? null).toBe(
          recorded ? "room-tone" : null,
        );
      },
    );

    it("ignores a retired same-key rejection after the new host confirms completion", async () => {
      const pending = deferred<RecordUploadStatus>();
      const view = setup({ transport: withStatus(() => pending.promise) });
      view.rerender({
        transport: withStatus(async () => ({
          segments: [],
          room_tone_status: [{ participant_id: "p_late", file_ack: true }],
        })),
      });
      await act(async () => {});
      expect(view.result.current).toBeNull();
      await act(async () => pending.reject(new Error("old offline")));
      expect(view.result.current).toBeNull();
    });

    it("does not read marks or start requests for an attempted suspended key", async () => {
      const a = snap();
      const b = snap({ session_id: "B" });
      const pending = deferred();
      const consumed = vi.spyOn(pending.promise, "then");
      const read = vi.spyOn(Storage.prototype, "getItem");
      const status = vi.fn(async () => ({ segments: [] }));
      const transport = withStatus(status);
      const roomTone = {
        status: "idle" as const,
        error: null,
        captureReady: true,
        record: vi.fn(),
        skip: vi.fn(),
      };
      function Probe({ snapshot }: { snapshot: RecordSnapshot }) {
        const alert = useLateRoomTone({
          snapshot,
          me,
          producer: false,
          transport,
          roomTone,
        });
        if (snapshot === b) throw pending.promise;
        return createElement(
          "output",
          { "aria-label": "Prompt" },
          alert?.kind ?? "quiet",
        );
      }
      function Host() {
        const [snapshot, setSnapshot] = useState(a);
        return createElement(
          "div",
          null,
          createElement(
            "button",
            {
              type: "button",
              onClick: () => startTransition(() => setSnapshot(b)),
            },
            "Attempt key",
          ),
          createElement(
            Suspense,
            { fallback: createElement("p", null, "Loading prompt") },
            createElement(Probe, { snapshot }),
          ),
        );
      }
      render(createElement(Host));
      await waitFor(() =>
        expect(screen.getByLabelText("Prompt")).toHaveTextContent("room-tone"),
      );
      expect(status).toHaveBeenCalledOnce();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Attempt key" }));
      });
      expect(consumed).toHaveBeenCalled();
      expect(screen.getByLabelText("Prompt")).toHaveTextContent("room-tone");
      expect(screen.queryByText("Loading prompt")).not.toBeInTheDocument();
      expect(status).toHaveBeenCalledOnce();
      expect(
        read.mock.calls.some(
          ([candidate]) => candidate === roomToneMarkKey("B", "p_late"),
        ),
      ).toBe(false);
    });
  });
});
