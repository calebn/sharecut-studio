import { composeStories } from "@storybook/react-vite";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import * as loadingStories from "./StageLoading.stories";

const { Edit, EditDark, EditPhone, EditTablet } =
  composeStories(loadingStories);

const cases = [
  {
    name: "wide at 1000px",
    story: Edit,
    width: 1000,
    height: 900,
    layout: "wide",
  },
  {
    name: "wide at 1280px",
    story: EditDark,
    width: 1280,
    height: 900,
    layout: "wide",
  },
  {
    name: "stacked at 999px",
    story: Edit,
    width: 999,
    height: 900,
    layout: "stacked",
  },
  {
    name: "tablet at 834px",
    story: EditTablet,
    width: 834,
    height: 900,
    layout: "stacked",
  },
  {
    name: "phone at 360px",
    story: EditPhone,
    width: 360,
    height: 800,
    layout: "phone",
  },
  {
    name: "phone at 390px",
    story: EditPhone,
    width: 390,
    height: 844,
    layout: "phone",
  },
  {
    name: "short landscape phone",
    story: EditPhone,
    width: 844,
    height: 390,
    layout: "phone",
  },
] as const;

const themes = [
  { name: "light", expectedFill: "rgb(238, 241, 240)" },
  { name: "dark", expectedFill: "rgb(19, 18, 17)" },
] as const;

let host: HTMLElement | undefined;

afterEach(() => {
  host?.remove();
  host = undefined;
  document.documentElement.removeAttribute("data-theme");
});

describe("Edit loading geometry in Chromium", () => {
  for (const viewport of cases) {
    for (const theme of themes) {
      it(`${viewport.name} in ${theme.name} theme`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme.name;
        host = document.createElement("div");
        host.id = "storybook-root";
        document.body.appendChild(host);
        await viewport.story.run({
          canvasElement: host,
          globals: { theme: theme.name },
        });
        await document.fonts.ready;

        const frame = host.querySelector<HTMLElement>(".stage-frame");
        const ruler = host.querySelector<HTMLElement>(
          ".stage-loading-block--ruler",
        );
        const lanes = Array.from(
          host.querySelectorAll<HTMLElement>(".stage-loading-block--lane"),
        );
        const script = host.querySelector<HTMLElement>(
          ".stage-loading-block--side",
        );
        expect(frame).not.toBeNull();
        expect(ruler).not.toBeNull();
        expect(lanes).toHaveLength(3);
        expect(script).not.toBeNull();
        if (!frame || !ruler || !script)
          throw new Error("Edit skeleton is incomplete");

        const timeline = [ruler, ...lanes];
        const rects = timeline.map((block) => block.getBoundingClientRect());
        for (const [index, rect] of rects.entries()) {
          expect(
            rect.width,
            `timeline block ${index} has rendered width`,
          ).toBeGreaterThan(0);
          if (index > 0) {
            expect(rect.top).toBeGreaterThan(rects[index - 1].top);
            expect(rect.left).toBeCloseTo(rects[0].left, 0);
            expect(rect.width).toBeCloseTo(rects[0].width, 0);
          }
          const style = getComputedStyle(timeline[index]);
          expect(style.backgroundColor).toBe(theme.expectedFill);
          expect(style.backgroundImage).toBe("none");
          expect(style.animationName).toBe("none");
        }

        const scriptRect = script.getBoundingClientRect();
        const timelineBottom = rects[rects.length - 1].bottom;
        if (viewport.layout === "wide") {
          expect(scriptRect.left).toBeGreaterThanOrEqual(rects[0].right);
          expect(scriptRect.top).toBeLessThan(timelineBottom);
        } else if (viewport.layout === "stacked") {
          expect(scriptRect.top).toBeGreaterThanOrEqual(timelineBottom);
        } else {
          expect(script.getClientRects().length).toBe(0);
        }

        const scriptStyle = getComputedStyle(script);
        expect(scriptStyle.backgroundColor).toBe(theme.expectedFill);
        expect(scriptStyle.backgroundImage).toBe("none");
        expect(scriptStyle.animationName).toBe("none");
        expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          viewport.width,
        );
      });
    }
  }
});
