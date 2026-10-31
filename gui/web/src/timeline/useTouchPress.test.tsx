import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_PRESS_MS } from "../hooks/gestureConstants";
import type { HitRouter } from "./hitRouting";
import { useTouchPress } from "./useTouchPress";

vi.mock("./hitRouting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hitRouting")>()),
  isReplayed: (event: Event) => (event as MouseEvent).detail === 7,
}));

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
    claimsClick: vi.fn(() => false),
    longPress: vi.fn(),
    choose: vi.fn(),
    nextPage: vi.fn(),
    openCreate: vi.fn(),
    close: vi.fn(),
    adopt: vi.fn(() => vi.fn()),
    disarm: vi.fn(),
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

  it("lets the router's replayed click reach its target while the press is open", () => {
    const { getByTestId } = render(<Lanes deferred />);
    const target = getByTestId("target");
    fireEvent.pointerDown(target, touch);
    fireEvent.pointerUp(target, touch);
    fireEvent.click(target, { detail: 7 });

    expect(owner.mock.calls.map(([e]) => (e as Event).type)).toEqual(["click"]);
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

  it("blocks a touch context menu during and just after a press, and no other", () => {
    const { getByTestId } = render(<Lanes deferred />);
    const target = getByTestId("target");
    const menu = (pointerType: string) =>
      target.dispatchEvent(
        new PointerEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          pointerType,
        }),
      );
    expect(menu("touch")).toBe(true);
    fireEvent.pointerDown(target, touch);
    expect(menu("touch")).toBe(false);
    expect(menu("mouse")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    fireEvent.pointerUp(target, touch);
    expect(menu("touch")).toBe(false);
    expect(menu("")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(menu("touch")).toBe(true);
  });

  it("leaves a keyboard click inside the click window to its target", () => {
    const { getByTestId } = render(<Lanes deferred />);
    const target = getByTestId("target");
    fireEvent.pointerDown(target, touch);
    fireEvent.pointerUp(target, touch);
    fireEvent.click(target, { detail: 0 });

    expect(owner.mock.calls.map(([e]) => (e as Event).type)).toEqual(["click"]);
  });

  it("starts a fresh press when the same pointer goes down without a release", () => {
    const { getByTestId } = render(<Lanes deferred />);
    const target = getByTestId("target");
    fireEvent.pointerDown(target, touch);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    fireEvent.pointerDown(target, touch);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });

    expect(router.longPress).toHaveBeenCalledTimes(2);
  });

  it("stops suppressing the browser's click once its window has passed", () => {
    const { getByTestId } = render(<Lanes deferred />);
    const target = getByTestId("target");
    fireEvent.pointerDown(target, touch);
    fireEvent.pointerUp(target, touch);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    fireEvent.click(target, { detail: 1 });

    expect(owner.mock.calls.map(([e]) => (e as Event).type)).toEqual(["click"]);
  });

  it("lets a tap on a target the router did not defer through right after a release", () => {
    const { getByTestId } = render(<Lanes deferred />);
    const target = getByTestId("target");
    fireEvent.pointerDown(target, touch);
    fireEvent.pointerUp(target, touch);
    router.defers = () => false;
    fireEvent.pointerDown(target, { ...touch, pointerId: 4 });
    fireEvent.pointerUp(target, { ...touch, pointerId: 4 });
    fireEvent.click(target, { detail: 1 });

    expect(owner.mock.calls.map(([e]) => (e as Event).type)).toEqual([
      "pointerdown",
      "click",
    ]);
  });

  it("does not suppress a click after a cancelled touch", () => {
    const { getByTestId } = render(<Lanes deferred />);
    const target = getByTestId("target");
    fireEvent.pointerDown(target, touch);
    fireEvent.pointerCancel(target, touch);
    fireEvent.click(target, { detail: 1 });

    expect(owner.mock.calls.map(([e]) => (e as Event).type)).toEqual(["click"]);
  });

  it("turns text selection off for the press and back on after", () => {
    const { getByTestId } = render(<Lanes deferred />);
    const target = getByTestId("target");
    fireEvent.pointerDown(target, touch);
    expect(document.documentElement.style.userSelect).toBe("none");
    fireEvent.pointerUp(target, touch);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.documentElement.style.userSelect).toBe("");
  });

  it("ends the press when a router listener stops the release before the document", () => {
    const { getByTestId } = render(<Lanes deferred />);
    const target = getByTestId("target");
    const stopRelease = (e: Event) => e.stopImmediatePropagation();
    document.addEventListener("pointerup", stopRelease, true);
    fireEvent.pointerDown(target, touch);
    fireEvent.pointerUp(target, touch);
    document.removeEventListener("pointerup", stopRelease, true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(document.documentElement.style.userSelect).toBe("");
    fireEvent.pointerDown(target, touch);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(router.longPress).toHaveBeenCalledOnce();
  });

  it("leaves a mouse click inside the click window to its target", () => {
    const { getByTestId } = render(<Lanes deferred />);
    const target = getByTestId("target");
    fireEvent.pointerDown(target, touch);
    fireEvent.pointerUp(target, touch);
    target.dispatchEvent(
      new PointerEvent("click", { bubbles: true, pointerType: "mouse" }),
    );

    expect(owner.mock.calls.map(([e]) => (e as Event).type)).toEqual(["click"]);
  });

  it("keeps text selection off until every instance has released it", () => {
    const first = render(<Lanes deferred />);
    const second = render(<Lanes deferred />);
    fireEvent.pointerDown(first.getAllByTestId("target")[0], touch);
    fireEvent.pointerDown(second.getAllByTestId("target")[1], {
      ...touch,
      pointerId: 4,
    });
    fireEvent.pointerUp(first.getAllByTestId("target")[0], touch);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.documentElement.style.userSelect).toBe("none");
    fireEvent.pointerUp(second.getAllByTestId("target")[1], {
      ...touch,
      pointerId: 4,
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.documentElement.style.userSelect).toBe("");
  });
});
