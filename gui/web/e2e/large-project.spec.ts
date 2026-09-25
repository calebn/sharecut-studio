import fs from "node:fs";
import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openHostProject } from "./overlayReachability";
import { scrollToEnd } from "./scroll";

// Diagnostic benchmark: no hardware-dependent pass/fail thresholds, so waits
// are generous and only bound a hung run.
const BENCHMARK_TEST_TIMEOUT_MS = 15 * 60_000;
const HEAVY = { timeout: 5 * 60_000 };

type Profile = {
  domNodes: number;
  heapBytes: number;
  label: string;
  milliseconds: number;
};

type BenchmarkShape = {
  name: string;
  firstClipId: string;
  lastClipId: string;
  utterances: number;
};

type ProjectJson = {
  meta: { name: string };
  timeline: { clips: { id: string; timeline_start: number }[] };
  transcripts: { combined: { utterances: unknown[] } | null };
};

/** Counts come from the generated project itself, never from duplicated env defaults. */
function readBenchmarkShape(): BenchmarkShape {
  const project = JSON.parse(
    fs.readFileSync(e2eProjectPath, "utf8"),
  ) as ProjectJson;
  if (!/large-project benchmark/i.test(project.meta.name)) {
    throw new Error(
      `DAW_E2E_PROJECT (${e2eProjectPath}) is not a generated benchmark project; ` +
        "build one with scripts/build_large_project_fixture.py and point DAW_E2E_PROJECT at it.",
    );
  }
  const clips = [...project.timeline.clips].sort(
    (a, b) => a.timeline_start - b.timeline_start,
  );
  return {
    name: project.meta.name,
    firstClipId: clips[0].id,
    lastClipId: clips[clips.length - 1].id,
    utterances: project.transcripts.combined?.utterances.length ?? 0,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function profile(
  page: Page,
  cdp: CDPSession,
  label: string,
  action: () => Promise<void>,
): Promise<Profile> {
  const start = performance.now();
  await action();
  await nextPaint(page);
  const milliseconds = performance.now() - start;
  const domNodes = await page.evaluate(
    () => document.getElementsByTagName("*").length,
  );
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  return { domNodes, heapBytes: usedSize, label, milliseconds };
}

test.describe("large project benchmark (opt-in fixture)", () => {
  test.skip(
    !process.env.DAW_BENCHMARK_PROJECT,
    "requires DAW_BENCHMARK_PROJECT=1 and DAW_E2E_PROJECT pointing at a generated benchmark project",
  );
  test("loads and exercises timeline, transcript, and history surfaces", async ({
    page,
  }) => {
    test.setTimeout(BENCHMARK_TEST_TIMEOUT_MS);
    const shape = readBenchmarkShape();
    const cdp = await page.context().newCDPSession(page);
    const slider = page.getByRole("slider", { name: "Timeline position" });
    const clipButton = (id: string) =>
      page.getByRole("button", { name: `Select clip ${id}`, exact: true });
    const profiles: Profile[] = [];

    profiles.push(
      await profile(page, cdp, "initial-load", async () => {
        const detail = page.waitForResponse(
          (response) =>
            response.url().includes("/api/project?") &&
            response.url().includes("phase=detail") &&
            response.ok(),
          HEAVY,
        );
        await openHostProject(
          page,
          new RegExp(escapeRegExp(shape.name), "i"),
          HEAVY,
        );
        await detail;
        await expect(
          page.getByRole("group", { name: "Loading timeline" }),
        ).toHaveCount(0, HEAVY);
        await expect(clipButton(shape.firstClipId)).toBeAttached(HEAVY);
      }),
    );

    const timeline = page.locator(".timeline-scroll");
    profiles.push(
      await profile(page, cdp, "timeline-scroll-seek", async () => {
        await scrollToEnd(timeline, "scrollLeft", HEAVY.timeout);
        await expect(clipButton(shape.lastClipId)).toBeInViewport(HEAVY);
        await slider.press("Home");
        await expect(slider).toHaveAttribute("aria-valuenow", "0", HEAVY);
        await slider.press("End");
        await expect(slider).toHaveAttribute(
          "aria-valuenow",
          (await slider.getAttribute("aria-valuemax")) ?? "",
          HEAVY,
        );
      }),
    );

    profiles.push(
      await profile(page, cdp, "transcript-open", async () => {
        await page
          .getByRole("button", { name: "Transcript", exact: true })
          .click();
        await expect(page.locator(".transcript-list")).toBeVisible(HEAVY);
        await expect(
          page.locator('.utterance-turn[data-turn-index="0"]'),
        ).toBeVisible(HEAVY);
        await expect(page.locator(".utterance-word").first()).toBeVisible(
          HEAVY,
        );
      }),
    );
    profiles.push(
      await profile(page, cdp, "transcript-scroll-seek", async () => {
        await scrollToEnd(
          page.locator(".transcript-list"),
          "scrollTop",
          HEAVY.timeout,
        );
        const lastTurn = page.locator(
          `.utterance-turn[data-turn-index="${shape.utterances - 1}"]`,
        );
        await expect(lastTurn).toBeVisible(HEAVY);
        const seek = lastTurn.locator(".utterance-seek");
        const title = (await seek.getAttribute("title")) ?? "";
        const target = Number(/\(([\d.]+)s\)/.exec(title)?.[1]);
        expect(Number.isFinite(target)).toBe(true);
        await seek.click();
        await expect
          .poll(async () => Number(await slider.getAttribute("aria-valuenow")))
          .toBeCloseTo(target, 0);
      }),
    );

    profiles.push(
      await profile(page, cdp, "history-load", async () => {
        await page
          .getByRole("button", { name: "History", exact: true })
          .click();
        const history = page.locator(".history-list");
        await expect(history).toBeVisible(HEAVY);
        await expect(history).not.toHaveAttribute("aria-busy", /.*/, HEAVY);
        await scrollToEnd(history, "scrollTop");
      }),
    );
    process.stdout.write(
      `large-project benchmark: ${JSON.stringify(profiles)}\n`,
    );
  });
});
