import { composeStories } from "@storybook/react-vite";
import axe from "axe-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { STORYBOOK_ONLY } from "./storybookOnlyStories";

const PHONE = 360;
const WIDE = 1280;
const HEIGHT = 900;
const THEMES = ["light", "dark"] as const;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const SHELL_TITLES = ["Stages/Edit/Frame"];

type ComposedStory = {
  run: (options: {
    canvasElement: HTMLElement;
    globals: Record<string, unknown>;
  }) => Promise<void>;
  tags: string[];
  parameters: { wideOnlyReason?: unknown };
  id: string;
  title: string;
  storyName: string;
};

const modules = import.meta.glob("../**/*.stories.{ts,tsx}", {
  eager: true,
}) as Record<string, Record<string, unknown>>;

const isPhoneStory = (name: string) => /\bphone\b/i.test(name);
const widthsFor = (story: ComposedStory) =>
  story.tags.includes("wide-only")
    ? [WIDE]
    : isPhoneStory(story.storyName)
      ? [PHONE]
      : [PHONE, WIDE];

function expectShellFit(width: number) {
  const shell = document.querySelector(".stage-frame");
  if (!shell) throw new Error("Frame story renders no .stage-frame");
  const main = shell.querySelector("main");
  if (!main) throw new Error("Frame has no main region");
  const rect = shell.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(width);
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
  expect(rect.height).toBe(HEIGHT);
  expect(main.getBoundingClientRect().height).toBeGreaterThan(200);
  expect(document.querySelectorAll("main, [role=main]")).toHaveLength(1);
  expect(
    document.querySelectorAll("h1, [role=heading][aria-level='1']"),
  ).toHaveLength(1);
}

const settle = async () => {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  await Promise.allSettled(
    document.getAnimations().map((animation) => animation.finished),
  );
};

const stories: ComposedStory[] = [];
for (const mod of Object.values(modules)) {
  const title = (mod.default as { title: string }).title;
  for (const story of Object.values(
    composeStories(mod as never) as Record<string, unknown>,
  ) as unknown as ComposedStory[]) {
    story.title = title;
    stories.push(story);
  }
}

let host: HTMLElement | undefined;

beforeAll(async () => {
  await document.fonts.ready;
});

afterEach(() => {
  host?.remove();
  host = undefined;
  document.documentElement.removeAttribute("data-theme");
});

/** `VITE_STORY_SHARD=i/n` runs every n-th story starting at i, since vitest shards by file. */
function parseShard(raw: string | undefined): { index: number; total: number } {
  if (raw === undefined || raw === "") return { index: 1, total: 1 };
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || index < 1 || index > total) {
    throw new Error(
      `VITE_STORY_SHARD must be i/n with 1 <= i <= n, got "${raw}"`,
    );
  }
  return { index, total };
}
const shard = parseShard(import.meta.env.VITE_STORY_SHARD);
const inShard = (position: number) =>
  position % shard.total === shard.index - 1;

for (const theme of THEMES) {
  describe(`stories in ${theme}`, () => {
    for (const [index, base] of stories.entries()) {
      if (!inShard(index)) continue;
      if (STORYBOOK_ONLY.includes(base.id)) continue;
      it(`${base.title} / ${base.storyName}`, async () => {
        const errors: string[] = [];
        const onError = (event: ErrorEvent) => errors.push(event.message);
        const onRejection = (event: PromiseRejectionEvent) =>
          errors.push(String(event.reason));
        window.addEventListener("error", onError);
        window.addEventListener("unhandledrejection", onRejection);
        const consoleError = vi
          .spyOn(console, "error")
          .mockImplementation((...args) => {
            errors.push(args.map(String).join(" "));
          });
        try {
          const [first, ...rest] = widthsFor(base);
          await page.viewport(first, HEIGHT);
          host = document.createElement("div");
          host.id = "storybook-root";
          document.body.appendChild(host);
          await base.run({ canvasElement: host, globals: { theme } });
          if (base.tags.includes("wide-only")) {
            const reason = base.parameters.wideOnlyReason;
            expect(
              typeof reason === "string" && reason.trim() !== "",
              "a wide-only story sets parameters.wideOnlyReason",
            ).toBe(true);
          }
          await document.fonts.ready;
          await settle();
          expect(document.documentElement.dataset.theme).toBe(theme);
          for (const width of [first, ...rest]) {
            if (width !== first) {
              await page.viewport(width, HEIGHT);
              await settle();
            }
            if (SHELL_TITLES.includes(base.title)) expectShellFit(width);
            expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
              width,
            );
            const results = await axe.run(document.documentElement, {
              runOnly: { type: "tag", values: AXE_TAGS },
            });
            expect(
              results.violations,
              JSON.stringify(results.violations, null, 2),
            ).toEqual([]);
            expect(errors).toEqual([]);
          }
        } finally {
          window.removeEventListener("error", onError);
          window.removeEventListener("unhandledrejection", onRejection);
          consoleError.mockRestore();
        }
      });
    }
  });
}
