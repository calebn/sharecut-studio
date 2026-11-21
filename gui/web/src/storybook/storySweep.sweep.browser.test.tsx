import {
  composeStory as composeReactStory,
  type Meta,
} from "@storybook/react-vite";
import axe from "axe-core";
import { storyNameFromExport } from "storybook/internal/csf";
import {
  composeStory as composeBareStory,
  composeStories,
} from "storybook/preview-api";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cdp, page } from "vitest/browser";
import {
  observeCleanupErrors,
  reportCleanupRejections,
} from "../test/storyCleanupErrors";
import {
  SHELL_TITLES,
  selectBrowserStoryShard,
} from "../test/storySweepPolicy";

const PHONE = 360;
const WIDE = 1280;
const HEIGHT = 900;
const THEMES = ["light", "dark"] as const;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

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

const atWidth = (width: number, what: string) => `${width}px wide: ${what}`;

function expectShellFit(width: number) {
  const { paddingTop, paddingRight, paddingBottom, paddingLeft } =
    getComputedStyle(document.body);
  expect(
    [paddingTop, paddingRight, paddingBottom, paddingLeft],
    atWidth(width, "the body does not pad the fullscreen frame"),
  ).toEqual(["0px", "0px", "0px", "0px"]);
  const shell = document.querySelector(".stage-frame");
  if (!shell)
    throw new Error(atWidth(width, "Frame story renders no .stage-frame"));
  const main = shell.querySelector("main");
  if (!main) throw new Error(atWidth(width, "Frame has no main region"));
  const rect = shell.getBoundingClientRect();
  expect(
    rect.left,
    atWidth(width, "frame starts inside the viewport"),
  ).toBeGreaterThanOrEqual(0);
  expect(
    rect.right,
    atWidth(width, "frame ends inside the viewport"),
  ).toBeLessThanOrEqual(width);
  expect(
    shell.scrollWidth,
    atWidth(width, "frame does not scroll sideways"),
  ).toBeLessThanOrEqual(shell.clientWidth);
  expect(rect.height, atWidth(width, "frame fills the viewport height")).toBe(
    HEIGHT,
  );
  expect(
    main.getBoundingClientRect().height,
    atWidth(width, "main region is taller than 200px"),
  ).toBeGreaterThan(200);
  expect(
    document.querySelectorAll("main, [role=main]"),
    atWidth(width, "exactly one main region"),
  ).toHaveLength(1);
  expect(
    document.querySelectorAll("h1, [role=heading][aria-level='1']"),
    atWidth(width, "exactly one level-1 heading"),
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

function composeStory(
  story: Parameters<typeof composeReactStory>[0],
  meta: Meta,
  project?: Parameters<typeof composeReactStory>[2],
  exportName?: string,
) {
  const hook = { beforeEach: reportCleanupRejections(story.beforeEach) };
  const renderable = !story.beforeEach
    ? story
    : typeof story === "function"
      ? Object.assign(story.bind(undefined), story, hook)
      : { ...story, ...hook };
  return composeReactStory(
    renderable,
    { ...meta, beforeEach: reportCleanupRejections(meta.beforeEach) },
    project && {
      ...project,
      beforeEach: reportCleanupRejections(project.beforeEach),
    },
    exportName,
  );
}

const stories: ComposedStory[] = [];
for (const mod of Object.values(modules)) {
  const title = (mod.default as { title: string }).title;
  for (const story of Object.values(
    composeStories(mod as never, {}, composeStory) as Record<string, unknown>,
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

// Portable stories normally clean up at the start of the next story. Load a
// story with no project hooks to flush teardown while its owner is observed.
const teardown = composeBareStory(
  { render: () => null },
  { title: "Sweep/Teardown" },
  {},
  {},
);
let networkErrors: string[] | undefined;
function onBrowserLog({
  entry,
}: {
  entry: { source: string; level: string; text: string; url?: string };
}) {
  if (
    entry.source === "network" &&
    entry.level === "error" &&
    !entry.url?.endsWith("/favicon.ico")
  ) {
    networkErrors?.push(
      entry.url ? `${entry.text} (${entry.url})` : entry.text,
    );
  }
}

beforeAll(async () => {
  await document.fonts.ready;
  await cdp().send("Log.enable");
  cdp().on("Log.entryAdded", onBrowserLog);
});

afterAll(async () => {
  cdp().off("Log.entryAdded", onBrowserLog);
  await cdp().send("Log.disable");
});

afterEach(() => {
  networkErrors = undefined;
  document.documentElement.removeAttribute("data-theme");
});

it("records an HTTP error reported by Chromium without console.error", async () => {
  const path = "/__sharecut_story_sweep_missing__.woff2";
  const errors: string[] = [];
  networkErrors = errors;
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
  });
  expect(response.status).toBe(404);
  await expect
    .poll(() => errors.some((error) => error.includes(path)))
    .toBe(true);
});

const shardStories = selectBrowserStoryShard(
  stories,
  import.meta.env.VITE_STORY_SHARD,
);

it("sweeps a non-empty set of stories in this shard", () => {
  expect(shardStories.length).toBeGreaterThan(0);
});

async function observeStory(
  check: (host: HTMLElement, errors: readonly string[]) => Promise<void>,
): Promise<string[]> {
  const host = document.createElement("div");
  host.id = "storybook-root";
  document.body.appendChild(host);
  const errors: string[] = [];
  networkErrors = errors;
  const cleanupRejections: unknown[] = [];
  const stopObservingCleanup = observeCleanupErrors(cleanupRejections);
  const onError = (event: ErrorEvent) => errors.push(event.message);
  const onRejection = (event: PromiseRejectionEvent) =>
    errors.push(String(event.reason));
  const onResourceError = (event: Event) => {
    if (event.target instanceof Element)
      errors.push(`failed to load ${event.target.outerHTML.slice(0, 120)}`);
  };
  window.addEventListener("error", onResourceError, true);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation((...args) => errors.push(args.map(String).join(" ")));
  try {
    let checkFailure: { error: unknown; errorCount: number } | undefined;
    try {
      await check(host, errors);
    } catch (error) {
      checkFailure = { error, errorCount: errors.length };
    } finally {
      await teardown.load().finally(() => host.remove());
      await settle();
      for (const error of cleanupRejections) {
        errors.push(`story cleanup: ${String(error)}`);
      }
    }
    if (checkFailure) {
      const teardownErrors = errors.slice(checkFailure.errorCount);
      if (teardownErrors.length > 0) {
        throw new AggregateError(
          [
            checkFailure.error,
            ...teardownErrors.map((error) => new Error(error)),
          ],
          "Story checks and teardown failed",
        );
      }
      throw checkFailure.error;
    }
  } finally {
    stopObservingCleanup();
    networkErrors = undefined;
    window.removeEventListener("error", onResourceError, true);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    consoleError.mockRestore();
  }
  return errors;
}

it("rejects body padding even when a fixed shell fills the viewport", async () => {
  await page.viewport(PHONE, HEIGHT);
  const originalPadding = document.body.style.padding;
  const shell = document.createElement("div");
  shell.className = "stage-frame";
  shell.style.cssText = "position:fixed;inset:0;display:block";
  shell.innerHTML = '<main style="height:300px"><h1>Shell fixture</h1></main>';
  document.body.appendChild(shell);
  try {
    expectShellFit(PHONE);
    document.body.style.padding = "8px";
    expect(() => expectShellFit(PHONE)).toThrow(/body does not pad/);
  } finally {
    document.body.style.padding = originalPadding;
    shell.remove();
  }
});

it("captures teardown and frame errors on the story that caused them", async () => {
  const meta = { title: "Sweep/Fixture", component: () => null };
  const failing = composeStory(
    {
      beforeEach: () => () => {
        window.dispatchEvent(
          new ErrorEvent("error", { message: "cleanup error" }),
        );
        requestAnimationFrame(() =>
          window.dispatchEvent(
            new ErrorEvent("error", { message: "next-frame cleanup error" }),
          ),
        );
      },
    },
    meta,
  );
  const clean = composeStory({}, meta);
  const firstErrors = await observeStory(async (host, errors) => {
    await failing.run({ canvasElement: host, globals: { theme: "light" } });
    expect(errors).toEqual([]);
  });
  const nextErrors = await observeStory(async (host) => {
    await clean.run({ canvasElement: host, globals: { theme: "light" } });
  });
  expect(firstErrors).toEqual(
    expect.arrayContaining(["cleanup error", "next-frame cleanup error"]),
  );
  expect(nextErrors).toEqual([]);
});

it("reports a rejected cleanup once and still runs the following story", async () => {
  const cleanupOrder: string[] = [];
  let reject = true;
  const failing = composeStory(
    {
      beforeEach: () => async () => {
        cleanupOrder.push("story cleanup");
        if (reject) {
          reject = false;
          throw new Error("cleanup fixture failed");
        }
      },
    },
    {
      title: "Sweep/Rejecting Fixture",
      component: () => null,
      beforeEach: [
        () => () => {
          cleanupOrder.push("component cleanup");
        },
      ],
    },
    {
      beforeEach:
        async ({ globals }) =>
        () => {
          cleanupOrder.push(`project cleanup in ${globals.theme}`);
        },
    },
  );
  const clean = composeStory(
    {},
    {
      title: "Sweep/Clean Fixture",
      component: () => <p>Clean story rendered</p>,
    },
  );
  const first = await observeStory(async (host) => {
    await failing.run({ canvasElement: host, globals: { theme: "light" } });
  }).then(
    (errors) => ({ errors }),
    (error: unknown) => ({ threw: String(error) }),
  );
  const ownerCleanupOrder = [...cleanupOrder];
  const nextErrors = await observeStory(async (host) => {
    await clean.run({ canvasElement: host, globals: { theme: "light" } });
    expect(host.textContent).toBe("Clean story rendered");
  });

  const expectedOrder = [
    "story cleanup",
    "component cleanup",
    "project cleanup in light",
  ];
  expect({ ownerCleanupOrder, cleanupOrder, first, nextErrors }).toEqual({
    ownerCleanupOrder: expectedOrder,
    cleanupOrder: expectedOrder,
    first: { errors: ["story cleanup: Error: cleanup fixture failed"] },
    nextErrors: [],
  });
});

it("reports both story check and cleanup failures", async () => {
  const failing = composeStory(
    {
      beforeEach: () => () => {
        throw new Error("teardown failed");
      },
    },
    { title: "Sweep/Dual Failure", component: () => null },
  );
  await expect(
    observeStory(async (host) => {
      await failing.run({ canvasElement: host, globals: { theme: "light" } });
      throw new Error("story check failed");
    }),
  ).rejects.toMatchObject({
    errors: [
      new Error("story check failed"),
      new Error("story cleanup: Error: teardown failed"),
    ],
  });
});

for (const theme of THEMES) {
  describe(`stories in ${theme}`, () => {
    for (const base of shardStories) {
      it(`${base.title} / ${base.storyName}`, async () => {
        const errors = await observeStory(async (host, errors) => {
          const widths = widthsFor(base);
          await page.viewport(widths[0], HEIGHT);
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
              atWidth(width, "page does not scroll sideways"),
            ).toBeLessThanOrEqual(width);
            const results = await axe.run(document.documentElement, {
              runOnly: { type: "tag", values: AXE_TAGS },
            });
            expect(
              results.violations,
              atWidth(
                width,
                `accessibility violations ${JSON.stringify(results.violations, null, 2)}`,
              ),
            ).toEqual([]);
            expect(
              errors,
              atWidth(width, "page, network, rejection or console errors"),
            ).toEqual([]);
          }
        });
        expect(
          errors,
          "page, network, rejection or console errors through teardown",
        ).toEqual([]);
      });
    }
  });
}
