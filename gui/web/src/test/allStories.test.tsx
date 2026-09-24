import { composeStories, setProjectAnnotations } from "@storybook/react-vite";
import { describe, expect, it } from "vitest";
import preview from "../../.storybook/preview";
import { expectNoA11yViolations } from "./a11y";

setProjectAnnotations(preview);

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
        await expectNoA11yViolations(document.body);
      } finally {
        canvasElement.remove();
      }
    },
  );
});
