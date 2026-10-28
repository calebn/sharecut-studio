import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { recordSnapshot } from "../test/fixtures";
import type { RecordSnapshot } from "./types";
import { useGuestRoomTone } from "./useGuestRoomTone";

const round = (n: number, ids: string[] = ["p_g"]) => ({
  round: n,
  requested_wall_ms: 1000 * n,
  duration_ms: 3000,
  participant_ids: ids,
});

type Props = {
  snapshot: RecordSnapshot | null;
  consented?: boolean | null;
  captureReady?: boolean;
};

function setup(initial: Props) {
  const record = vi.fn();
  const view = renderHook(
    (props: Props) =>
      useGuestRoomTone({
        snapshot: props.snapshot,
        participantId: "p_g",
        consented: props.consented === undefined ? true : props.consented,
        roomTone: { captureReady: props.captureReady ?? true, record },
      }),
    { initialProps: initial },
  );
  return { record, ...view };
}

const lobby = (room_tone?: ReturnType<typeof round> | null) =>
  recordSnapshot({ state: "lobby", room_tone, countdown_left_ms: 3000 });

describe("useGuestRoomTone", () => {
  it("records when the host starts a round that names the guest", () => {
    const { record, rerender } = setup({ snapshot: lobby() });
    expect(record).not.toHaveBeenCalled();
    rerender({ snapshot: lobby(round(1)) });
    expect(record).toHaveBeenCalledOnce();
  });

  it("records each new round once, not on every snapshot", () => {
    const { record, rerender } = setup({ snapshot: lobby() });
    rerender({ snapshot: lobby(round(1)) });
    rerender({ snapshot: lobby(round(1)) });
    rerender({ snapshot: lobby(null) });
    expect(record).toHaveBeenCalledTimes(1);
    rerender({ snapshot: lobby(round(2)) });
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("leaves a round that was already running at the first snapshot", () => {
    const { record, rerender } = setup({ snapshot: lobby(round(1)) });
    rerender({ snapshot: lobby(round(1)) });
    expect(record).not.toHaveBeenCalled();
    rerender({ snapshot: lobby(round(2)) });
    expect(record).toHaveBeenCalledOnce();
  });

  it("waits for a snapshot before deciding what is new", () => {
    const { record, rerender } = setup({ snapshot: null });
    rerender({ snapshot: lobby(round(1)) });
    expect(record).not.toHaveBeenCalled();
  });

  it("ignores a round that does not name this guest", () => {
    const { record, rerender } = setup({ snapshot: lobby() });
    rerender({ snapshot: lobby(round(1, ["p_other"])) });
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ["has not consented", { consented: null }],
    ["has declined", { consented: false }],
    ["has no capture ready", { captureReady: false }],
  ])("does not record when the guest %s", (_name, extra) => {
    const { record, rerender } = setup({ snapshot: lobby(), ...extra });
    rerender({ snapshot: lobby(round(1)), ...extra });
    expect(record).not.toHaveBeenCalled();
  });

  it("does not catch up on a round it could not record", () => {
    const { record, rerender } = setup({
      snapshot: lobby(),
      captureReady: false,
    });
    rerender({ snapshot: lobby(round(1)), captureReady: false });
    rerender({ snapshot: lobby(round(1)), captureReady: true });
    expect(record).not.toHaveBeenCalled();
  });
});
