import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { expectStoryAxeClean } from "../e2e/axe";
import { expectRootFit, expectShellFit } from "./shellFit";
import { type StoryTheme, storyUrl } from "./storyUrl";

interface IndexEntry {
  id: string;
  title: string;
  name: string;
  type: string;
  tags?: string[];
}

const WIDTHS = [360, 1280] as const;

/**
 * A story tagged `wide-only` is built around a layout that needs a viewport
 * wider than the phone (a fixed design width or a desktop-only play), so it
 * is checked at 1280 only.
 */
const widthsFor = (story: IndexEntry) =>
  story.tags?.includes("wide-only") ? ([1280] as const) : WIDTHS;
const THEMES: StoryTheme[] = ["light", "dark"];

/** Full-geometry stories: the shell fits the viewport; the others fit the root. */
const SHELL_TITLES = new Set(["Templates/Shell"]);
const ROOT_FIT_TITLES = new Set([
  "Templates/Editor · Transcript panel",
  "Templates/Home",
  "Templates/Home · Setup wizard",
]);

test.describe.configure({ mode: "parallel" });

const index = JSON.parse(
  readFileSync("storybook-static/index.json", "utf8"),
) as { entries: Record<string, IndexEntry> };

const stories = Object.values(index.entries).filter(
  (entry) => entry.type === "story" && entry.id.startsWith("templates-"),
);

test("the Storybook index lists template stories", () => {
  expect(stories.length).toBeGreaterThan(0);
});

for (const story of stories) {
  for (const width of widthsFor(story)) {
    for (const theme of THEMES) {
      test(`${story.title} / ${story.name} at ${width} in ${theme}`, async ({
        page,
      }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() !== "error") return;
          if (message.location().url.endsWith("/favicon.ico")) return;
          errors.push(message.text());
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(storyUrl(story.id, { theme }));
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await page.waitForFunction(
          () => {
            const phase = (
              window as unknown as {
                __STORYBOOK_PREVIEW__?: { currentRender?: { phase?: string } };
              }
            ).__STORYBOOK_PREVIEW__?.currentRender?.phase;
            return phase === "finished" || phase === "errored";
          },
          undefined,
          { timeout: 20_000 },
        );
        await expect(page.locator("body.sb-show-errordisplay")).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);

        if (SHELL_TITLES.has(story.title)) await expectShellFit(page, width);
        else if (ROOT_FIT_TITLES.has(story.title))
          await expectRootFit(page, width);
        const documentWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(documentWidth).toBeLessThanOrEqual(width);
        await expectStoryAxeClean(page);
        expect(errors).toEqual([]);
      });
    }
  }
}
