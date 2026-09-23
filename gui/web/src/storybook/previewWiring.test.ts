import { GLOBALS_UPDATED } from "storybook/internal/core-events";
import { afterEach, expect, it, vi } from "vitest";
import "../../.storybook/preview";

const listeners = vi.hoisted(
  () =>
    new Map<string, (event: { globals: Record<string, unknown> }) => void>(),
);

vi.mock("storybook/preview-api", () => ({
  addons: {
    getChannel: () => ({
      on: (
        event: string,
        listener: (event: { globals: Record<string, unknown> }) => void,
      ) => {
        listeners.set(event, listener);
      },
      off: (event: string) => listeners.delete(event),
    }),
  },
}));

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

it("applies the toolbar theme from Storybook's globals event before docs render", () => {
  const onGlobalsUpdated = listeners.get(GLOBALS_UPDATED);
  expect(onGlobalsUpdated).toBeDefined();

  onGlobalsUpdated?.({ globals: { theme: "light" } });
  expect(document.documentElement.dataset.theme).toBe("light");
  onGlobalsUpdated?.({ globals: { theme: "dark" } });
  expect(document.documentElement.dataset.theme).toBe("dark");
});
