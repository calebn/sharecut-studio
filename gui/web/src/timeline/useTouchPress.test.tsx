import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_PRESS_MS } from "../hooks/gestureConstants";
import type { HitRouter } from "./hitRouting";
import { useTouchPress } from "./useTouchPress";

let router: HitRouter;
const owner = vi.fn();

function Lanes({ deferred }: { deferred: boolean }) {
  const press = useTouchPress(router);
  router.defers = () => deferred;
  return (
    <div data-testid="root" {...press}>
      <button
        type="button"
        data-testid="target"
        onPointerDown={owner}
        onClick={owner}
      />
    </div>
  );
}

const touch = { pointerType: "touch", pointerId: 3, button: 0 };

beforeEach(() => {
  vi.useFakeTimers();
  owner.mockClear();
  router = {
    dispose: vi.fn(),
    defers: vi.fn(),
    longPress: vi.fn(),
    choose: vi.fn(),
    nextPage: vi.fn(),
    close: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useTouchPress", () => {
  it("keeps a deferred touch, and the click after it, from its target", () => {
    const { getByTestId } = render(<Lanes deferred />);
    const target = getByTestId("target");
    fireEvent.pointerDown(target, touch);
    fireEvent.pointerUp(target, touch);
    fireEvent.click(target, { detail: 1 });

    expect(owner.mock.calls.map(([e]) => (e as Event).type)).toEqual([]);
    expect(router.longPress).not.toHaveBeenCalled();
  });

  it("reports nothing when the browser takes the touch to scroll", () => {
    const { getByTestId } = render(<Lanes deferred />);
    const target = getByTestId("target");
    fireEvent.pointerDown(target, touch);
    fireEvent.pointerCancel(target, touch);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });

    expect(router.longPress).not.toHaveBeenCalled();
  });

  it("reports a long press after LONG_PRESS_MS", () => {
    const { getByTestId } = render(<Lanes deferred />);
    const target = getByTestId("target");
    fireEvent.pointerDown(target, touch);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    });
    expect(router.longPress).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(router.longPress).toHaveBeenCalledOnce();
  });

  it("leaves a press the router did not defer to its target", () => {
    const { getByTestId } = render(<Lanes deferred={false} />);
    fireEvent.pointerDown(getByTestId("target"), touch);

    expect(owner).toHaveBeenCalledOnce();
  });
});
