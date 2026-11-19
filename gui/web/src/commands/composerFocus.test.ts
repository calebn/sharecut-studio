import { afterEach, expect, it, vi } from "vitest";
import { focusComposerFromKey, registerComposerFocus } from "./composerFocus";

let release: (() => void) | null = null;
afterEach(() => release?.());

it("does nothing and reports it while no composer is registered", () => {
  expect(focusComposerFromKey()).toBe(false);
});

it("calls the registered focus and returns what it says", () => {
  const focus = vi.fn(() => true);
  release = registerComposerFocus(focus);
  expect(focusComposerFromKey()).toBe(true);
  expect(focus).toHaveBeenCalledOnce();
});

it("forgets a composer when it unregisters, and keeps a newer one when an older one does", () => {
  const first = vi.fn(() => true);
  const second = vi.fn(() => true);
  const releaseFirst = registerComposerFocus(first);
  release = registerComposerFocus(second);
  releaseFirst();
  expect(focusComposerFromKey()).toBe(true);
  expect(second).toHaveBeenCalledOnce();
  release();
  expect(focusComposerFromKey()).toBe(false);
});
