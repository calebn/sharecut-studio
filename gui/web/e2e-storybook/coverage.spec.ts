import { readFileSync } from "node:fs";
import {
  test as base,
  type ConsoleMessage,
  devices,
  expect,
  type Page,
} from "@playwright/test";
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

const PHONE = 360;
const WIDE = 1280;
const THEMES: StoryTheme[] = ["light", "dark"];

/**
 * Each worker opens Storybook once and moves between stories through the
 * preview channel, as the Storybook UI does, so a story costs a render and an
 * axe run rather than a page load. A story is checked at every width on that
 * live page. A story tagged `wide-only` is built around a layout that needs a
 * viewport wider than the phone (a fixed design width or a desktop-only play),
 * so it is checked at 1280 only. A story named for a phone width is checked at
 * 360 only, and never carries `wide-only`.
 */
const isPhoneStory = (story: IndexEntry) => /phone/i.test(story.name);
const widthsFor = (story: IndexEntry) =>
  story.tags?.includes("wide-only")
    ? [WIDE]
    : isPhoneStory(story)
      ? [PHONE]
      : [PHONE, WIDE];

/** Full-geometry stories: the shell fits the viewport; the others fit the root. */
const SHELL_TITLES = ["Templates/Shell"];
const ROOT_FIT_TITLES = [
  "Templates/Editor · Transcript panel",
  "Templates/Home",
  "Templates/Home · Setup wizard",
];

base.describe.configure({ mode: "parallel" });

const index = JSON.parse(
  readFileSync("storybook-static/index.json", "utf8"),
) as { entries: Record<string, IndexEntry> };

const stories = Object.values(index.entries).filter(
  (entry) => entry.type === "story" && entry.id.startsWith("templates-"),
);

base("the Storybook index lists template stories", () => {
  expect(stories.length).toBeGreaterThan(0);
});

base("the geometry title sets name existing stories", () => {
  const titles = new Set(stories.map((story) => story.title));
  expect(
    [...SHELL_TITLES, ...ROOT_FIT_TITLES].filter((title) => !titles.has(title)),
  ).toEqual([]);
});

base("no phone-named story is tagged wide-only", () => {
  expect(
    stories
      .filter(
        (story) => isPhoneStory(story) && story.tags?.includes("wide-only"),
      )
      .map((story) => story.id),
  ).toEqual([]);
});

const STORYBOOK_URL = "http://127.0.0.1:6010";

type Channel = { emit: (event: string, payload: unknown) => void };
type PreviewWindow = {
  __STORYBOOK_ADDONS_CHANNEL__: Channel;
  __STORYBOOK_PREVIEW__?: { currentRender?: { id?: string; phase?: string } };
};

const test = base.extend<object, { storybook: Page }>({
  storybook: [
    async ({ browser }, use) => {
      const context = await browser.newContext({
        ...devices["Desktop Chrome"],
        baseURL: STORYBOOK_URL,
      });
      const page = await context.newPage();
      await page.goto(storyUrl(stories[0].id, { theme: "light" }));
      await use(page);
      await context.close();
    },
    { scope: "worker" },
  ],
});

const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(
    ({ event, payload }) =>
      (window as unknown as PreviewWindow).__STORYBOOK_ADDONS_CHANNEL__.emit(
        event,
        payload,
      ),
    { event, payload },
  );

const renderSettled = (page: Page, id?: string) =>
  page.waitForFunction(
    (storyId) => {
      const render = (window as unknown as PreviewWindow).__STORYBOOK_PREVIEW__
        ?.currentRender;
      return (
        render !== undefined &&
        (storyId === undefined || render.id === storyId) &&
        (render.phase === "finished" || render.phase === "errored")
      );
    },
    id,
    { timeout: 20_000 },
  );

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

for (const theme of THEMES) {
  for (const story of stories) {
    test(`${story.title} / ${story.name} in ${theme}`, async ({
      storybook: page,
    }) => {
      const [first, ...rest] = widthsFor(story);
      await page.setViewportSize({ width: first, height: 900 });
      const errors: string[] = [];
      const onError = (error: Error) => errors.push(error.message);
      const onConsole = (message: ConsoleMessage) => {
        if (message.type() !== "error") return;
        if (message.location().url.endsWith("/favicon.ico")) return;
        errors.push(`${message.text()} (${message.location().url})`);
      };
      page.on("pageerror", onError);
      page.on("console", onConsole);
      try {
        if ((await page.locator("html").getAttribute("data-theme")) === theme) {
          await emit(page, "setCurrentStory", {
            storyId: story.id,
            viewMode: "story",
          });
        } else {
          await page.goto(storyUrl(story.id, { theme }));
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
        }
        await renderSettled(page, story.id);
        await expect(page.locator("body.sb-show-errordisplay")).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);

        for (const width of [first, ...rest]) {
          await test.step(`at ${width}`, async () => {
            if (width !== first) {
              await page.setViewportSize({ width, height: 900 });
              await settle(page);
            }
            if (SHELL_TITLES.includes(story.title))
              await expectShellFit(page, width);
            else if (ROOT_FIT_TITLES.includes(story.title))
              await expectRootFit(page, width);
            const documentWidth = await page.evaluate(
              () => document.documentElement.scrollWidth,
            );
            expect(documentWidth).toBeLessThanOrEqual(width);
            await expectStoryAxeClean(page);
            expect(errors).toEqual([]);
          });
        }
      } finally {
        page.off("pageerror", onError);
        page.off("console", onConsole);
      }
    });
  }
}
