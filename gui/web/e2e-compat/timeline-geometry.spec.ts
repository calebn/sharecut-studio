import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { parseRulerLabel } from "../e2e/deepZoom";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { withShareableProject } from "../e2e/shareableProject";
import { zoomTimelineIn } from "../e2e/timelineZoom";
import { expectPaintedWaveformTile } from "../e2e/waveformHook";
import { timelineTestIds } from "../src/timeline/selectors";

const TOLERANCE_PX = 0.5;
const SOURCE_START = 5;
const SOURCE_END = 30;
const TIMELINE_START = 10;
const MUTE_START = 29;

test("snap ticks, mute regions and a live trim ghost share the ruler geometry", async ({
  page,
}) => {
  let clipId = "";
  await withShareableProject(
    async (projectPath) => {
      await page.setViewportSize({ width: 1512, height: 805 });
      await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        /aligned dialogue/i,
      );
      await expectPaintedWaveformTile(page);
      await zoomTimelineIn(page, { maxSteps: 12, minRangePx: 400 });
      const lane = page
        .getByTestId(timelineTestIds.lane)
        .and(page.locator('[data-track-id="guest"]'));
      const clip = lane.getByTestId(timelineTestIds.clip);
      const scroll = page.locator(".timeline-scroll");
      await scroll.evaluate((element) => {
        element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
      });
      await expect
        .poll(() => scroll.evaluate((el) => el.scrollLeft))
        .toBeGreaterThan(0);
      const committed = await clip.boundingBox();
      const handle = await clip
        .getByTestId(timelineTestIds.trimOut)
        .boundingBox();
      if (!committed || !handle)
        throw new Error("The clip trim handle did not mount");
      await page.mouse.move(
        handle.x + handle.width / 2,
        handle.y + handle.height / 2,
      );
      await page.mouse.down();
      try {
        await page.mouse.move(
          handle.x + handle.width / 2 + 40,
          handle.y + handle.height / 2,
          { steps: 8 },
        );
        await expect(
          lane.getByTestId(timelineTestIds.snapTick).first(),
        ).toBeVisible();
        await expect(clip.getByTestId(timelineTestIds.trimGhost)).toBeVisible();
        await expect(async () => {
          const geometry = await lane.evaluate((element, ids) => {
            const ticks = [
              ...document.querySelectorAll<HTMLElement>(
                `[data-testid="${ids.rulerTick}"], [data-testid="${ids.rulerEndTick}"]`,
              ),
            ].map((tick) => {
              const box = tick.getBoundingClientRect();
              return {
                label: tick.textContent ?? "",
                x:
                  tick.dataset.testid === ids.rulerEndTick
                    ? box.right
                    : box.left,
              };
            });
            const snap = [
              ...element.querySelectorAll<HTMLElement>(
                `[data-testid="${ids.snapTick}"]`,
              ),
            ].map((tick) => ({
              sourceSec: Number(tick.dataset.sourceSec),
              x: tick.getBoundingClientRect().left,
            }));
            const mute = element.querySelector<HTMLElement>(
              `[data-testid="${ids.muteRegion}"]`,
            );
            const ghostWave = element.querySelector<HTMLElement>(
              `[data-testid="${ids.trimGhost}"] [data-testid="${ids.waveform}"]`,
            );
            return {
              ticks,
              snap,
              muteX: mute?.getBoundingClientRect().left,
              ghostX: ghostWave?.getBoundingClientRect().left,
            };
          }, timelineTestIds);
          expect(geometry.ticks.length).toBeGreaterThanOrEqual(2);
          const [first, second] = geometry.ticks;
          if (!first || !second)
            throw new Error("Two ruler ticks are required");
          const firstSec = parseRulerLabel(first.label);
          const scale =
            (second.x - first.x) / (parseRulerLabel(second.label) - firstSec);
          const timeX = (sec: number) => first.x + (sec - firstSec) * scale;
          expect(geometry.snap.length).toBeGreaterThan(0);
          for (const tick of geometry.snap) {
            expect(
              Math.abs(
                tick.x - timeX(TIMELINE_START + tick.sourceSec - SOURCE_START),
              ),
            ).toBeLessThanOrEqual(TOLERANCE_PX);
          }
          expect(geometry.muteX).toBeDefined();
          expect(
            Math.abs(
              geometry.muteX! -
                timeX(TIMELINE_START + MUTE_START - SOURCE_START),
            ),
          ).toBeLessThanOrEqual(TOLERANCE_PX);
          expect(geometry.ghostX).toBeDefined();
          expect(
            Math.abs(geometry.ghostX! - (committed.x + committed.width)),
          ).toBeLessThanOrEqual(TOLERANCE_PX);
        }).toPass();
      } finally {
        await page.mouse.up();
      }
      await expect(clip.getByTestId(timelineTestIds.trimGhost)).toHaveCount(0);
      await expect
        .poll(() => {
          const saved = JSON.parse(fs.readFileSync(projectPath, "utf8"));
          return saved.timeline.clips.find(
            (row: { id: string }) => row.id === clipId,
          ).source_end;
        })
        .toBeGreaterThan(SOURCE_END);
    },
    undefined,
    (prefix) => {
      const created = createRelocatedE2eProject(prefix);
      try {
        const project = JSON.parse(
          fs.readFileSync(created.projectPath, "utf8"),
        );
        const clip = project.timeline.clips.find(
          (row: { track_id: string }) => row.track_id === "guest",
        );
        clipId = clip.id;
        Object.assign(clip, {
          source_start: SOURCE_START,
          source_end: SOURCE_END,
          timeline_start: TIMELINE_START,
          mute_regions: [{ start_s: MUTE_START, end_s: MUTE_START + 0.5 }],
        });
        fs.writeFileSync(
          created.projectPath,
          `${JSON.stringify(project, null, 2)}\n`,
        );
      } catch (error) {
        removeRelocatedE2eProject(created.workspaceDir);
        throw error;
      }
      return created;
    },
  );
});
