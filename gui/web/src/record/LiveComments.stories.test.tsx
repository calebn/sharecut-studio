import { composeStories } from "@storybook/react-vite";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import * as stories from "./LiveComments.stories";

const composed = Object.entries(composeStories(stories));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("LiveComments stories", () => {
  it.each(composed)(
    "%s renders, plays and passes axe",
    async (_name, Story) => {
      const canvasElement = document.createElement("div");
      document.body.appendChild(canvasElement);
      await Story.run({ canvasElement });
      await expectNoA11yViolations(canvasElement);
    },
  );
});
