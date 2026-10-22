import { expect, test } from "@playwright/test";
import { newFinger } from "./finger";
import { openPhoneTimeline } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { projectJson, watchCommands } from "./touchTimeline";

/*
 * #1034: a long-press clip move interrupted by a rotation. The phone shell
 * swaps layout under the finger; the move must end without a write, and the
 * same gesture left alone must still save, so the first case is not a harness
 * that cannot move a clip. Automated receipts only: not physical-device proof.
 */

test.use({ hasTouch: true });

const starts = async (
  page: Parameters<typeof projectJson>[0],
  projectPath: string,
) => {
  const tracks = (await projectJson(page, projectPath)).clips.tracks;
  return Object.values(tracks)
    .flat()
    .map((c) => [c.id, c.timeline_start]);
};

for (const rotate of [false, true]) {
  test(
    rotate
      ? "rotating the phone mid long-press move saves nothing"
      : "a long-press move on the phone saves one MoveClips",
    async ({ page, context, browserName }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await withShareableProject(async (projectPath) => {
        await openHostShare(page, projectPath);
        await openPhoneTimeline(page);
        const before = await starts(page, projectPath);
        const commands = watchCommands(page);
        const hit = page.locator(".clip-hit").first();
        await expect(hit).toBeVisible();
        const box = (await hit.boundingBox())!;
        const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const finger = await newFinger(context, page, browserName);

        await finger.down(at);
        await expect(page.locator("[data-hit-armed]")).toHaveCount(1);
        await finger.slide({ x: at.x + 40, y: at.y }, 4, 16);
        if (rotate) {
          await page.setViewportSize({ width: 844, height: 390 });
          await expect(page.locator("[data-hit-armed]")).toHaveCount(0);
          await finger.slide({ x: at.x + 80, y: at.y }, 4, 16);
        }
        await finger.up();

        if (rotate) {
          await page.waitForTimeout(500);
          expect(commands.filter((c) => c.type === "MoveClips")).toEqual([]);
          expect(await starts(page, projectPath)).toEqual(before);
        } else {
          await expect
            .poll(() => commands.filter((c) => c.type === "MoveClips").length)
            .toBe(1);
        }
      });
    },
  );
}
