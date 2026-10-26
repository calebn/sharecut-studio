import { composeStories, setProjectAnnotations } from "@storybook/react-vite";
import { describe, expect, it, vi } from "vitest";
import preview from "../../.storybook/preview";
import { type A11yRule, expectNoA11yViolations } from "./a11y";

setProjectAnnotations(preview);

// jsdom has no layout: every observed element counts as fully on screen.
vi.stubGlobal(
  "IntersectionObserver",
  class {
    callback: (
      entries: { isIntersecting: boolean; intersectionRatio: number }[],
    ) => void;
    constructor(callback: typeof this.callback) {
      this.callback = callback;
    }
    observe() {
      this.callback([{ isIntersecting: true, intersectionRatio: 1 }]);
    }
    disconnect() {}
  },
);

const modules = import.meta.glob(
  ["../**/*.stories.ts", "../**/*.stories.tsx"],
  {
    eager: true,
  },
);
const stories = Object.entries(modules).flatMap(([path, module]) =>
  Object.entries(
    composeStories(module as Parameters<typeof composeStories>[0]),
  ).map(([name, Story]) => ({
    path,
    name,
    Story: Story as {
      run: (options: { canvasElement: HTMLElement }) => Promise<void>;
      parameters: { a11y?: { config?: { rules?: A11yRule[] } } };
    },
  })),
);

describe("all Storybook stories", () => {
  it("discovers colocated stories", () => {
    expect(stories.length).toBeGreaterThan(0);
  });

  it.each(stories)(
    "$path: $name renders, plays, and passes axe",
    async ({ Story }) => {
      const canvasElement = document.body.appendChild(
        document.createElement("div"),
      );
      try {
        await Story.run({ canvasElement });
        if (!canvasElement.querySelector("main")) {
          canvasElement.setAttribute("role", "main");
        }
        // Some stories render overlays into document.body via React portals.
        await expectNoA11yViolations(
          document.body,
          Story.parameters.a11y?.config?.rules,
        );
      } finally {
        canvasElement.remove();
      }
    },
  );
});
