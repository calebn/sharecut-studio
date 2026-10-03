import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { VIRTUALIZE_ON_ROWS } from "../src/hooks/virtualRowThresholds";
import { rulerWidthPx } from "./deepZoom";
import { createEditorProfiler } from "./editorProfile";
import type { WorkloadObservation } from "./editorProfileReport";
import { e2eProjectPath } from "./env";
import { openHostProject } from "./overlayReachability";
import { scrollToEnd } from "./scroll";

// Diagnostic benchmark: no hardware-dependent pass/fail thresholds, so waits
// are generous and only bound a hung run.
const BENCHMARK_TEST_TIMEOUT_MS = 15 * 60_000;
const HEAVY = { timeout: 5 * 60_000 };
const DEFAULT_SCRUB_ROUNDS = 20;
const SCRUB_KEY_PRESSES = 10;

/** Rounds of the extended scrub session; a positive integer from the environment. */
function scrubRounds(): number {
  const raw = process.env.DAW_BENCHMARK_SCRUB_ROUNDS;
  if (raw === undefined || raw === "") {
    return DEFAULT_SCRUB_ROUNDS;
  }
  const rounds = Number(raw);
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(
      `DAW_BENCHMARK_SCRUB_ROUNDS must be a positive integer, got "${raw}"`,
    );
  }
  return rounds;
}
const SCRUB_ROUNDS = scrubRounds();

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
  historyEntries: number;
};

type ProjectJson = {
  meta: { name: string };
  timeline: { clips: { id: string; timeline_start: number }[] };
  transcripts: { combined: { utterances: unknown[] } | null };
  history?: { entries: unknown[] };
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
    historyEntries: project.history?.entries.length ?? 0,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type EditorProfiler = Awaited<ReturnType<typeof createEditorProfiler>>;

async function profile(
  recorder: EditorProfiler,
  label: string,
  action: () => Promise<WorkloadObservation | void>,
): Promise<Profile> {
  const sample = await recorder.measure(
    {
      id: label,
      input:
        label === "initial-load"
          ? "browser navigation"
          : "existing UI controls; programmatic scroll where specified",
      phase: label === "initial-load" ? "first-load" : "warm",
    },
    async () => (await action()) ?? { kind: "existing", contract: label },
  );
  const memory = await recorder.memory(label);
  return {
    domNodes: memory.domNodes,
    heapBytes: memory.heapBytes,
    label,
    milliseconds: sample.driverWallMs,
  };
}

test.describe("large project benchmark (opt-in fixture)", () => {
  test.skip(
    !process.env.DAW_BENCHMARK_PROJECT,
    "requires DAW_BENCHMARK_PROJECT=1 and DAW_E2E_PROJECT pointing at a generated benchmark project",
  );
  test("loads and exercises timeline, transcript, and history surfaces", async ({
    page,
    headless,
  }, info) => {
    test.setTimeout(BENCHMARK_TEST_TIMEOUT_MS);
    const shape = readBenchmarkShape();
    const cdp = await page.context().newCDPSession(page);
    const recorder = await createEditorProfiler(
      page,
      cdp,
      info,
      e2eProjectPath,
      SCRUB_ROUNDS,
      headless,
    );
    let failure: unknown;
    try {
      const slider = page.getByRole("slider", { name: "Timeline position" });
      const clipButton = (id: string) =>
        page.locator(`[data-clip-id="${id}"] .clip-hit`);
      const profiles: Profile[] = [];
      const historyStepCount = shape.historyEntries / 2;
      if (historyStepCount < VIRTUALIZE_ON_ROWS)
        recorder.report.coverage.push({
          id: "history-keyboard",
          result: {
            status: "not-run",
            reason: "seeded history is below the virtualized row threshold",
          },
        });
      if (!shape.historyEntries)
        for (const id of ["history-diff", "history-undo-redo"])
          recorder.report.coverage.push({
            id,
            result: {
              status: "not-run",
              reason: "fixture has no seeded history",
            },
          });

      profiles.push(
        await profile(recorder, "initial-load", async () => {
          const detail = page.waitForResponse(
            (response) =>
              response.url().includes("/api/document/state?") &&
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
          return {
            kind: "load",
            detailLoaded: true,
            firstClipId: shape.firstClipId,
          };
        }),
      );

      const timeline = page.locator(".timeline-scroll");
      profiles.push(
        await profile(recorder, "timeline-scroll-seek", async () => {
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

      await slider.focus();
      await recorder.measure(
        {
          id: "timeline-zoom",
          phase: "warm",
          input: "browser keyboard '=' once",
        },
        async () => {
          const beforeScale = await rulerWidthPx(page);
          await page.keyboard.press("=");
          await expect
            .poll(() => rulerWidthPx(page))
            .toBeGreaterThan(beforeScale);
          return {
            kind: "zoom",
            beforeScale,
            afterScale: await rulerWidthPx(page),
          };
        },
      );
      await timeline.evaluate((element) => {
        element.scrollLeft = 0;
      });
      const wheelEvents = await timeline.evaluateHandle((element) => {
        const trusted: boolean[] = [];
        element.addEventListener(
          "wheel",
          (event) => trusted.push(event.isTrusted),
          { capture: true, once: true },
        );
        return trusted;
      });
      const visibleClips = () =>
        timeline.evaluate((element) => {
          const viewport = element.getBoundingClientRect();
          return [...element.querySelectorAll<HTMLElement>("[data-clip-id]")]
            .filter((clip) => {
              const rect = clip.getBoundingClientRect();
              return rect.right > viewport.left && rect.left < viewport.right;
            })
            .map((clip) => clip.dataset.clipId!)
            .slice(0, 20);
        });
      await timeline.hover({ position: { x: 300, y: 60 } });
      await recorder.measure(
        {
          id: "timeline-wheel",
          phase: "warm",
          input: "browser wheel deltaX=600 deltaY=0 once",
        },
        async () => {
          const before = await timeline.evaluate(
            (element) => element.scrollLeft,
          );
          const beforeVisibleClipIds = await visibleClips();
          const range = await timeline.evaluate(
            (element) => element.scrollWidth - element.clientWidth,
          );
          expect(range).toBeGreaterThan(100);
          await page.mouse.wheel(600, 0);
          await expect
            .poll(() => timeline.evaluate((element) => element.scrollLeft))
            .toBeGreaterThan(before + Math.min(100, range / 2));
          const after = await timeline.evaluate(
            (element) => element.scrollLeft,
          );
          const afterVisibleClipIds = await visibleClips();
          expect(afterVisibleClipIds).not.toEqual(beforeVisibleClipIds);
          const trusted = await wheelEvents.jsonValue();
          expect(trusted).toContain(true);
          return {
            kind: "scroll",
            before,
            after,
            trustedEvents: trusted.filter(Boolean).length,
            beforeVisibleClipIds,
            afterVisibleClipIds,
          };
        },
      );
      await wheelEvents.dispose();
      await timeline.evaluate((element) => {
        element.scrollLeft = 0;
      });
      await slider.press("Home");
      await recorder.measure(
        {
          id: "ruler-click-seek",
          phase: "warm",
          input: "browser mouse click at ruler local x=240 y=10",
        },
        async () => {
          const beforeSeconds = Number(
            await slider.getAttribute("aria-valuenow"),
          );
          await slider.click({ position: { x: 240, y: 10 } });
          await expect
            .poll(async () =>
              Number(await slider.getAttribute("aria-valuenow")),
            )
            .toBeGreaterThan(beforeSeconds);
          return {
            kind: "seek",
            beforeSeconds,
            afterSeconds: Number(await slider.getAttribute("aria-valuenow")),
          };
        },
      );

      profiles.push(
        await profile(recorder, "transcript-open", async () => {
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
        await profile(recorder, "transcript-scroll-seek", async () => {
          await scrollToEnd(
            page.locator(".transcript-list"),
            "scrollTop",
            HEAVY.timeout,
          );
          const lastTurn = page.locator(
            `.utterance-turn[data-turn-index="${shape.utterances - 1}"]`,
          );
          await expect(lastTurn).toBeVisible(HEAVY);
          const seek = lastTurn.locator('.utterance-seek[title^="Seek turn"]');
          const title = (await seek.getAttribute("title")) ?? "";
          const target = Number(/\(([\d.]+)s\)/.exec(title)?.[1]);
          expect(Number.isFinite(target)).toBe(true);
          await seek.click();
          await expect
            .poll(async () =>
              Number(await slider.getAttribute("aria-valuenow")),
            )
            .toBeCloseTo(target, 0);
        }),
      );

      profiles.push(
        await profile(recorder, "history-load", async () => {
          await page
            .getByRole("button", { name: "History", exact: true })
            .click();
          const history = page.locator(".history-list");
          await expect(history).toBeVisible(HEAVY);
          await expect(history).not.toHaveAttribute("aria-busy", /.*/, HEAVY);
          await scrollToEnd(history, "scrollTop", HEAVY.timeout);
          if (shape.historyEntries > 0) {
            const steps = Number(
              /(\d+) steps/.exec(
                (await page.locator(".history-toolbar").textContent()) ?? "",
              )?.[1],
            );
            expect(steps).toBeGreaterThan(0);
            await expect(
              page.locator(`[data-history-index="${steps - 1}"]`),
            ).toBeVisible(HEAVY);
          }
        }),
      );

      if (shape.historyEntries > 0) {
        const historyPanel = page.locator(".history-panel");
        profiles.push(
          await profile(recorder, "history-diff", async () => {
            await historyPanel.locator("button.history-row").last().click();
            await expect(historyPanel.locator(".history-summary")).toBeVisible(
              HEAVY,
            );
          }),
        );
        profiles.push(
          await profile(recorder, "history-undo-redo", async () => {
            const undo = historyPanel.getByRole("button", {
              name: "Undo",
              exact: true,
            });
            const redo = historyPanel.getByRole("button", {
              name: "Redo",
              exact: true,
            });
            await expect(undo).toBeEnabled(HEAVY);
            await undo.click();
            await expect(redo).toBeEnabled(HEAVY);
            await redo.click();
            await expect(redo).toBeDisabled(HEAVY);
          }),
        );
        if (historyStepCount >= VIRTUALIZE_ON_ROWS) {
          profiles.push(
            await profile(recorder, "history-keyboard", async () => {
              const historyList = historyPanel.locator(".history-list");
              await expect(historyList).toHaveClass(
                /\bis-virtualized\b/,
                HEAVY,
              );
              await historyList.evaluate((el) => {
                el.scrollTop = 0;
              });
              const first = historyPanel.locator(
                'button.history-row[data-history-index="0"]',
              );
              await expect(first).toBeVisible(HEAVY);
              const lastMounted = await historyPanel
                .locator("button.history-row")
                .evaluateAll((rows) =>
                  Math.max(
                    ...rows.map((row) =>
                      Number(row.getAttribute("data-history-index")),
                    ),
                  ),
                );
              const focusedIndex = () =>
                page.evaluate(() =>
                  Number(
                    document.activeElement?.getAttribute(
                      "data-history-index",
                    ) ?? -1,
                  ),
                );
              await first.focus();
              await expect.poll(focusedIndex, HEAVY).toBe(0);
              for (let index = 1; index <= lastMounted + 1; index++) {
                await page.keyboard.press("Tab");
                await expect.poll(focusedIndex, HEAVY).toBe(index);
              }
            }),
          );
        }
      }

      const endurance: (Pick<Profile, "domNodes" | "heapBytes"> & {
        round: number;
      })[] = [];
      const enduranceStart = performance.now();
      await page
        .getByRole("button", { name: "Transcript", exact: true })
        .click();
      await expect(page.locator(".transcript-list")).toBeVisible(HEAVY);
      for (let round = 0; round < SCRUB_ROUNDS; round++) {
        await recorder.measure(
          {
            id: "scrub-endurance",
            phase: "sustained",
            input:
              "programmatic scroll; browser keyboard Home/End and ten arrows",
            iteration: round + 1,
          },
          async () => {
            const fraction = (round % 5) / 4;
            await timeline.evaluate((el, f) => {
              el.scrollLeft = (el.scrollWidth - el.clientWidth) * f;
            }, fraction);
            await slider.press(round % 2 === 0 ? "Home" : "End");
            for (let i = 0; i < SCRUB_KEY_PRESSES; i++)
              await slider.press(round % 2 === 0 ? "ArrowRight" : "ArrowLeft");
            const value = Number(await slider.getAttribute("aria-valuenow"));
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(
              Number(await slider.getAttribute("aria-valuemax")),
            );
            return {
              kind: "existing",
              contract:
                "programmatic scroll plus bounded playhead after ten native arrow seeks",
            };
          },
        );
        endurance.push({
          round: round + 1,
          ...(await recorder.memory(`scrub-round-${round + 1}`)),
        });
      }
      recorder.report.legacyEnduranceWallMs =
        performance.now() - enduranceStart;
      const last = endurance.at(-1)!;
      profiles.push({
        label: "scrub-endurance",
        milliseconds: recorder.report.legacyEnduranceWallMs,
        domNodes: last.domNodes,
        heapBytes: last.heapBytes,
      });
      await recorder.trace(async () => {
        await recorder.measure(
          {
            id: "diagnostic-keyboard-seek",
            phase: "diagnostic",
            input: "browser keyboard Home/ArrowRight; Chrome tracing enabled",
          },
          async () => {
            await slider.press("Home");
            await slider.press("ArrowRight");
            await expect(slider).not.toHaveAttribute("aria-valuenow", "0");
            return {
              kind: "seek",
              beforeSeconds: 0,
              afterSeconds: Number(await slider.getAttribute("aria-valuenow")),
            };
          },
        );
      });
      process.stdout.write(
        `large-project endurance: ${JSON.stringify(endurance)}\n`,
      );
      process.stdout.write(
        `large-project benchmark: ${JSON.stringify(profiles)}\n`,
      );
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await recorder.finish(failure);
      } catch (error) {
        if (failure === undefined) throw error;
        process.stderr.write(`profile cleanup: ${String(error)}\n`);
      } finally {
        try {
          await cdp.detach();
        } catch (error) {
          if (failure === undefined) throw error;
          process.stderr.write(`CDP cleanup: ${String(error)}\n`);
        }
      }
    }
  });
});
