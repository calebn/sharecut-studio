import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { keepActivationKeys } from "./trackHeaderKeys";

const ev = (
  key: string,
  mods: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {},
) => {
  const stopPropagation = vi.fn();
  const event = {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
    stopPropagation,
  } as unknown as KeyboardEvent<HTMLElement>;
  return { event, stopPropagation };
};

describe("keepActivationKeys", () => {
  it("stops propagation for a bare Space", () => {
    const { event, stopPropagation } = ev(" ");
    keepActivationKeys(event);
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("stops propagation for a bare Enter", () => {
    const { event, stopPropagation } = ev("Enter");
    keepActivationKeys(event);
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("keeps Shift+Space on the button (Shift is not a chord)", () => {
    const { event, stopPropagation } = ev(" ", { shiftKey: true });
    keepActivationKeys(event);
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("keeps Shift+Enter on the button (Shift is not a chord)", () => {
    const { event, stopPropagation } = ev("Enter", { shiftKey: true });
    keepActivationKeys(event);
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("ignores other keys", () => {
    const { event, stopPropagation } = ev("M");
    keepActivationKeys(event);
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it("lets a Meta+Enter chord reach the keymap", () => {
    const { event, stopPropagation } = ev("Enter", { metaKey: true });
    keepActivationKeys(event);
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it("lets a Ctrl+Enter chord reach the keymap", () => {
    const { event, stopPropagation } = ev("Enter", { ctrlKey: true });
    keepActivationKeys(event);
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it("lets an Alt+Space chord reach the keymap", () => {
    const { event, stopPropagation } = ev(" ", { altKey: true });
    keepActivationKeys(event);
    expect(stopPropagation).not.toHaveBeenCalled();
  });
});
