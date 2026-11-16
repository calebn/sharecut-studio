import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCoverPress } from "./useCoverPress";
import { HELD_BUSY_MS } from "./useHeldBusy";

type Props = { key: string; trying: boolean };

function setup(initial: Props = { key: "asleep", trying: false }) {
  return renderHook(
    (props: Props) =>
      useCoverPress({
        ...props,
        stillFailing: "Still asleep.",
        changed: `${props.key}.`,
      }),
    { initialProps: initial },
  );
}

describe("useCoverPress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("says nothing before a press", () => {
    const { result } = setup();
    expect(result.current).toMatchObject({ busy: false, status: "" });
  });

  it("is busy and says Trying again… from the press, for at least the held time", () => {
    const { result, rerender } = setup();
    act(() => result.current.press());
    rerender({ key: "asleep", trying: true });
    expect(result.current).toMatchObject({
      busy: true,
      status: "Trying again…",
    });
    rerender({ key: "asleep", trying: false });
    expect(result.current.busy).toBe(true);
    act(() => void vi.advanceTimersByTime(HELD_BUSY_MS));
    expect(result.current).toMatchObject({
      busy: false,
      status: "Still asleep.",
    });
  });

  it("says what a different cover is when it answers the press", () => {
    const { result, rerender } = setup();
    act(() => result.current.press());
    rerender({ key: "offline", trying: true });
    act(() => void vi.advanceTimersByTime(HELD_BUSY_MS));
    rerender({ key: "offline", trying: false });
    expect(result.current.status).toBe("offline.");
  });

  it("forgets the press when an attempt nobody pressed starts", () => {
    const { result, rerender } = setup();
    act(() => result.current.press());
    rerender({ key: "asleep", trying: true });
    act(() => void vi.advanceTimersByTime(HELD_BUSY_MS));
    rerender({ key: "asleep", trying: false });
    expect(result.current.status).toBe("Still asleep.");
    rerender({ key: "asleep", trying: true });
    expect(result.current).toMatchObject({ busy: false, status: "" });
  });
});
