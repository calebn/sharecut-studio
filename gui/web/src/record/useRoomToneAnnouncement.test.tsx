import {
  act,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RoomAlert } from "../system/RoomAlert";
import type { RoomToneStatus } from "./roomTone";
import { roomToneCapturingAlert, roomToneClock } from "./roomTone";
import {
  ROOM_TONE_START_ANNOUNCEMENT,
  useRoomToneAnnouncement,
} from "./useRoomToneAnnouncement";

function lines(initial: RoomToneStatus) {
  return renderHook(
    ({ status }: { status: RoomToneStatus }) => useRoomToneAnnouncement(status),
    { initialProps: { status: initial } },
  );
}

describe("room tone announcements", () => {
  it("speaks once when a take starts and once when it is cancelled", () => {
    const { result, rerender } = lines("idle");
    expect(result.current).toBeNull();
    rerender({ status: "capturing" });
    expect(result.current?.text).toBe(ROOM_TONE_START_ANNOUNCEMENT);
    const startSeq = result.current?.seq;
    rerender({ status: "capturing" });
    expect(result.current?.seq).toBe(startSeq);
    rerender({ status: "idle" });
    expect(result.current?.text).toBe("Room tone cancelled");
  });

  it.each([
    ["recorded", "Room tone recorded"],
    ["too_short", "Too short, record at least 10 seconds"],
  ] as const)("speaks once when a take ends as %s", (status, text) => {
    const { result, rerender } = lines("idle");
    rerender({ status: "capturing" });
    rerender({ status });
    expect(result.current?.text).toBe(text);
  });

  it("says nothing for a status change that is not a take", () => {
    const { result, rerender } = lines("idle");
    rerender({ status: "skipped" });
    expect(result.current).toBeNull();
  });

  it("keeps the ticking countdown out of any polite live region", () => {
    const alert = roomToneCapturingAlert({
      status: "capturing",
      clock: roomToneClock(18),
      endEarly: () => undefined,
      cancel: () => undefined,
    });
    if (!alert) throw new Error("expected an alert");
    render(<RoomAlert alerts={[alert]} />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "off");
    const tick = within(region).getByRole("timer");
    expect(tick).toHaveTextContent("Stay quiet · 0:42");
    expect(tick.closest('[aria-live="polite"]')).toBeNull();
    act(() => undefined);
  });
});
