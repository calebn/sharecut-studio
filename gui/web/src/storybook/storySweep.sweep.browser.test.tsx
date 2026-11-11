import { composeStories } from "@storybook/react-vite";
import axe from "axe-core";
import { storyNameFromExport } from "storybook/internal/csf";
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

const isPhoneStory = (name: string) =>
  /\bphone\b/i.test(storyNameFromExport(name));
const widthsFor = (story: ComposedStory) =>
  story.tags.includes("wide-only")
    ? [WIDE]
    : SHELL_TITLES.includes(story.title)
      ? [PHONE, WIDE]
      : isPhoneStory(story.storyName)
        ? [PHONE]
        : [PHONE, WIDE];

function expectShellFit(width: number) {
  const shell = document.querySelector(".stage-frame");
  if (!shell) throw new Error("Frame story renders no .stage-frame");
  const main = shell.querySelector("main");
  if (!main) throw new Error("Frame has no main region");
  const rect = shell.getBoundingClientRect();
  const at = (what: string) => `${width}px wide: ${what}`;
  expect(
    rect.left,
    at("frame starts inside the viewport"),
  ).toBeGreaterThanOrEqual(0);
  expect(rect.right, at("frame ends inside the viewport")).toBeLessThanOrEqual(
    width,
  );
  expect(
    shell.scrollWidth,
    at("frame does not scroll sideways"),
  ).toBeLessThanOrEqual(shell.clientWidth);
  expect(rect.height, at("frame fills the viewport height")).toBe(HEIGHT);
  expect(
    main.getBoundingClientRect().height,
    at("main region is taller than 200px"),
  ).toBeGreaterThan(200);
  expect(
    document.querySelectorAll("main, [role=main]"),
    at("exactly one main region"),
  ).toHaveLength(1);
  expect(
    document.querySelectorAll("h1, [role=heading][aria-level='1']"),
    at("exactly one level-1 heading"),
  ).toHaveLength(1);
}

const settle = async () => {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  const running = document.getAnimations();
  for (const animation of running) {
    if (animation.effect?.getComputedTiming().iterations === Infinity) {
      animation.cancel();
    }
  }
  await Promise.allSettled(running.map((animation) => animation.finished));
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

describe("viewport policy", () => {
  it("recognizes phone export names without matching words that contain phone", () => {
    expect(isPhoneStory("Phone360")).toBe(true);
    expect(isPhoneStory("PHONE_DOCK")).toBe(true);
    expect(isPhoneStory("Headphone")).toBe(false);
    expect(isPhoneStory("Telephone")).toBe(false);
  });

  it("runs the composed ActionBar PhoneDock story at phone width only", () => {
    const phoneDock = stories.find(
      (story) => story.id === "system-actionbar--phone-dock",
    );

    expect(phoneDock).toBeDefined();
    expect(widthsFor(phoneDock!)).toEqual([PHONE]);
  });

  it("runs the composed ActionBar PhoneDockPlayhead story at phone width only", () => {
    const phoneDockPlayhead = stories.find(
      (story) => story.id === "system-actionbar--phone-dock-playhead",
    );

    expect(phoneDockPlayhead).toBeDefined();
    expect(widthsFor(phoneDockPlayhead!)).toEqual([PHONE]);
  });

  it("keeps the explicitly named Phone Dock 390 story at phone width only", () => {
    const phoneDock390 = stories.find(
      (story) => story.id === "system-actionbar--phone-dock-390",
    );

    expect(phoneDock390).toBeDefined();
    expect(widthsFor(phoneDock390!)).toEqual([PHONE]);
  });

  it("keeps the ordinary ActionBar Words story at both viewport widths", () => {
    const words = stories.find(
      (story) => story.id === "system-actionbar--words",
    );

    expect(words).toBeDefined();
    expect(widthsFor(words!)).toEqual([PHONE, WIDE]);
  });
  it("prioritizes wide-only tags while preserving Frame, phone, and default widths", () => {
    const recordingLive = stories.find(
      (story) =>
        story.title === "Stages/Edit/Frame" &&
        story.storyName === "RecordingLive",
    );
    const untaggedFrame = stories.find(
      (story) =>
        story.title === "Stages/Edit/Frame" && story.storyName === "Tablet",
    );
    const taggedNonFrame = stories.find(
      (story) =>
        story.title !== "Stages/Edit/Frame" && story.tags.includes("wide-only"),
    );
    const phoneStory = stories.find(
      (story) =>
        story.title === "Stages/Settings/ModelsSheet" &&
        story.storyName === "Phone",
    );
    const ordinaryStory = stories.find(
      (story) =>
        story.title !== "Stages/Edit/Frame" &&
        !story.tags.includes("wide-only") &&
        !isPhoneStory(story.storyName),
    );

    expect(recordingLive && widthsFor(recordingLive)).toEqual([WIDE]);
    expect(untaggedFrame && widthsFor(untaggedFrame)).toEqual([PHONE, WIDE]);
    expect(taggedNonFrame && widthsFor(taggedNonFrame)).toEqual([WIDE]);
    expect(phoneStory && widthsFor(phoneStory)).toEqual([PHONE]);
    expect(ordinaryStory && widthsFor(ordinaryStory)).toEqual([PHONE, WIDE]);
  });
});

let host: HTMLElement | undefined;

beforeAll(async () => {
  await document.fonts.ready;
});

afterEach(() => {
  host?.remove();
  host = undefined;
  document.documentElement.removeAttribute("data-theme");
});

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

it("sweeps a non-empty set of stories in this shard", () => {
  expect(
    stories.filter((_, position) => inShard(position)).length,
  ).toBeGreaterThan(0);
});

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
        const onResourceError = (event: Event) => {
          if (event.target instanceof Element) {
            errors.push(
              `failed to load ${event.target.outerHTML.slice(0, 120)}`,
            );
          }
        };
        window.addEventListener("error", onResourceError, true);
        window.addEventListener("error", onError);
        window.addEventListener("unhandledrejection", onRejection);
        const consoleError = vi
          .spyOn(console, "error")
          .mockImplementation((...args) => {
            errors.push(args.map(String).join(" "));
          });
        try {
          const widths = widthsFor(base);
          await page.viewport(widths[0], HEIGHT);
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
          for (const width of widths) {
            if (width !== widths[0]) {
              await page.viewport(width, HEIGHT);
              await settle();
            }
            if (SHELL_TITLES.includes(base.title)) expectShellFit(width);
            expect(
              document.documentElement.scrollWidth,
              `${width}px wide: page does not scroll sideways`,
            ).toBeLessThanOrEqual(width);
            const results = await axe.run(document.documentElement, {
              runOnly: { type: "tag", values: AXE_TAGS },
            });
            expect(
              results.violations,
              `${width}px wide: ${JSON.stringify(results.violations, null, 2)}`,
            ).toEqual([]);
            expect(errors, `${width}px wide: console or load errors`).toEqual(
              [],
            );
          }
        } finally {
          window.removeEventListener("error", onResourceError, true);
          window.removeEventListener("error", onError);
          window.removeEventListener("unhandledrejection", onRejection);
          consoleError.mockRestore();
        }
      });
    }
  });
}
