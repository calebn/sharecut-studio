import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { resetServerClock } from "../presence/clock";
import { resetPublishKeyForTests } from "../state/publishKey";

// axe color-contrast probes canvas; jsdom has no implementation.
HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null);

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
});
