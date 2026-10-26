import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { resetServerClock } from "../presence/clock";
import { resetPublishKeyForTests } from "../state/publishKey";
import { resetFeedbackRepeatForTests } from "../state/uiSlice";
import { resetQuestions } from "./ask";

// axe color-contrast probes canvas; jsdom has no implementation.
HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null);

// jsdom has no Popover API and its UA stylesheet hides every closed
// [popover]: showing one drops the attribute so Menu panels render.
HTMLElement.prototype.showPopover ??= function showPopover(this: HTMLElement) {
  this.removeAttribute("popover");
};
HTMLElement.prototype.hidePopover ??= () => undefined;

// jsdom has no hit testing; axe's elementsFromPoint polyfill calls this.
document.elementFromPoint ??= () => null;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

afterEach(() => {
  cleanup();
  // Module-level singletons (one DAW store per JS runtime): reset so no test
  // sees another's server clock offset or cached publish key.
  resetServerClock();
  resetPublishKeyForTests();
  resetQuestions();
  resetFeedbackRepeatForTests();
});
