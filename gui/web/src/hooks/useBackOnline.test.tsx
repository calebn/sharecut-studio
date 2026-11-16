import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBackOnline } from "./useBackOnline";

const online = () => act(() => void window.dispatchEvent(new Event("online")));
const deviceOnline = (value: boolean) =>
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(value);

function mount(armed: boolean, attempt = 0, onBack = vi.fn()) {
  const view = renderHook(
    (props: { armed: boolean; attempt: number; onBack: () => void }) =>
      useBackOnline(props.armed, props.attempt, props.onBack),
    { initialProps: { armed, attempt, onBack } },
  );
  return { ...view, onBack };
}

describe("useBackOnline", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls back once when the connection returns while armed, however many events follow", () => {
    const { onBack } = mount(true);
    online();
    online();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("does nothing for an event while not armed and nothing is armed afterwards", () => {
    const { onBack } = mount(false);
    online();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("remembers an event that came while not armed and calls back once when armed with the browser online", () => {
    deviceOnline(true);
    const { onBack, rerender } = mount(false);
    online();
    rerender({ armed: true, attempt: 0, onBack });
    expect(onBack).toHaveBeenCalledOnce();
    rerender({ armed: false, attempt: 0, onBack });
    rerender({ armed: true, attempt: 0, onBack });
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("calls back once for a missed event even when a live one follows before the page disarms", () => {
    deviceOnline(true);
    const { onBack, rerender } = mount(false);
    online();
    rerender({ armed: true, attempt: 0, onBack });
    online();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("does not call back on arming when the browser still reports no connection", () => {
    deviceOnline(false);
    const { onBack, rerender } = mount(false);
    online();
    rerender({ armed: true, attempt: 0, onBack });
    expect(onBack).not.toHaveBeenCalled();
  });

  it("forgets an event when a new attempt starts", () => {
    deviceOnline(true);
    const { onBack, rerender } = mount(false);
    online();
    rerender({ armed: false, attempt: 1, onBack });
    rerender({ armed: true, attempt: 1, onBack });
    expect(onBack).not.toHaveBeenCalled();
  });

  it("calls the latest callback and stops listening once unmounted", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = mount(true, 0, first);
    rerender({ armed: true, attempt: 0, onBack: second });
    online();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    unmount();
    online();
    expect(second).toHaveBeenCalledOnce();
  });
});
