import { describe, expect, it, vi } from "vitest";
import { listenerSet } from "./listenerSet";

describe("listenerSet", () => {
  it("passes emit args to every listener, and unsubscribes", () => {
    const l = listenerSet<[string, number]>();
    const a = vi.fn();
    const b = vi.fn();
    const off = l.subscribe(a);
    l.subscribe(b);
    l.emit("k", 1);
    expect(a).toHaveBeenCalledWith("k", 1);
    expect(b).toHaveBeenCalledWith("k", 1);
    off();
    l.emit("k", 2);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("emits over a snapshot", () => {
    const l = listenerSet();
    const b = vi.fn();
    const c = vi.fn();
    let offB = () => {};
    const a = vi.fn(() => {
      offB();
      l.subscribe(c);
    });
    l.subscribe(a);
    offB = l.subscribe(b);
    l.emit();
    expect(b).toHaveBeenCalledOnce();
    expect(c).not.toHaveBeenCalled();
    l.emit();
    expect(b).toHaveBeenCalledOnce();
    expect(c).toHaveBeenCalledOnce();
  });
});
