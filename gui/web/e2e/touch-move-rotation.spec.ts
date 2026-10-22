import { expect, test } from "@playwright/test";
import { newFinger } from "./finger";
import { openPhoneTimeline } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { projectJson, watchCommands } from "./touchTimeline";

/*
 * #1034: a long-press clip move interrupted by a rotation. The phone shell
 * swaps layout under the finger; the interrupted move must save nothing. The
 * proof that nothing was queued is ordering, not elapsed time: a second,
 * uninterrupted move on the same clip is sent through the same command queue,
 * so once it has saved, an earlier stray write would already be in the log.
 * Automated receipts only: not physical-device proof.
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

test("a long-press move on the phone saves one MoveClips and the clip moves", async ({
  page,
  context,
  browserName,
}) => {
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
    await finger.up();

    await expect
      .poll(() => commands.filter((c) => c.type === "MoveClips").length)
      .toBe(1);
    await expect
      .poll(async () => await starts(page, projectPath))
      .not.toEqual(before);
  });
});

test("rotating the phone mid long-press move saves nothing, and a later move saves once", async ({
  page,
  context,
  browserName,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await withShareableProject(async (projectPath) => {
    await openHostShare(page, projectPath);
    await openPhoneTimeline(page);
    const commands = watchCommands(page);
    const moves = () => commands.filter((c) => c.type === "MoveClips");
    const hit = page.locator(".clip-hit").first();
    await expect(hit).toBeVisible();
    const box = (await hit.boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const finger = await newFinger(context, page, browserName);

    await finger.down(at);
    await expect(page.locator("[data-hit-armed]")).toHaveCount(1);
    await finger.slide({ x: at.x + 40, y: at.y }, 4, 16);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator("[data-hit-armed]")).toHaveCount(0);
    await finger.slide({ x: at.x + 80, y: at.y }, 4, 16);
    await finger.up();
    const afterRotation = await starts(page, projectPath);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(hit).toBeVisible();
    const again = (await hit.boundingBox())!;
    const from = {
      x: again.x + again.width / 2,
      y: again.y + again.height / 2,
    };
    const sentBeforeSecond = moves().length;
    await finger.down(from);
    await expect(page.locator("[data-hit-armed]")).toHaveCount(1);
    await finger.slide({ x: from.x + 40, y: from.y }, 4, 16);
    await finger.up();

    expect(sentBeforeSecond).toBe(0);
    await expect.poll(() => moves().length).toBeGreaterThanOrEqual(1);
    await expect
      .poll(async () => await starts(page, projectPath))
      .not.toEqual(afterRotation);
    expect(moves()).toHaveLength(1);
  });
});
