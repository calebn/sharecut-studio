import { describe, expect, it, vi } from "vitest";
import { keyedListeners } from "./keyedListeners";

describe("keyedListeners", () => {
  it("notifies only the key's listeners and unsubscribes", () => {
    const l = keyedListeners();
    const a = vi.fn();
    const b = vi.fn();
    const offA = l.subscribe("k", a);
    l.subscribe("other", b);
    l.notify("k");
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    offA();
    l.notify("k");
    expect(a).toHaveBeenCalledOnce();
  });

  it("lets a listener unsubscribe while notified, and clears", () => {
    const l = keyedListeners();
    const second = vi.fn();
    const off = l.subscribe("k", () => off());
    l.subscribe("k", second);
    l.notify("k");
    expect(second).toHaveBeenCalledOnce();
    l.clear();
    l.notify("k");
    expect(second).toHaveBeenCalledOnce();
  });
});
