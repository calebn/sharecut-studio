import { expect, type Locator, type Page, test } from "@playwright/test";
import { rulerWidthPx } from "./deepZoom";
import { createScriptRecordingIdentityProject } from "./scriptRecordingIdentityProject";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";

test.use({ hasTouch: true, reducedMotion: "reduce" });

async function overlapArea(a: Locator, b: Locator) {
  const [first, second] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  if (!first || !second) return null;
  const width =
    Math.min(first.x + first.width, second.x + second.width) -
    Math.max(first.x, second.x);
  const height =
    Math.min(first.y + first.height, second.y + second.height) -
    Math.max(first.y, second.y);
  return Math.max(0, width) * Math.max(0, height);
}

async function inspectSelectedClip(page: Page, touch: boolean) {
  const clip = page.locator('[data-clip-id="other"] .clip-hit');
  const widthAtFit = await rulerWidthPx(page);
  const ruler = page.locator(".timeline-ruler");
  const position = { x: 0.9 * widthAtFit, y: 8 };
  if (touch) await ruler.tap({ position });
  else await ruler.click({ position });
  await clip.press("Enter");
  await expect(clip).toHaveAttribute("aria-pressed", "true");
  const inspect = page.getByRole("button", { name: "Inspect", exact: true });
  if (touch) await inspect.tap();
  else await inspect.click();
}

const cases = [
  { width: 844, height: 530, other: "Timeline view", role: "group" },
  { width: 844, height: 530, other: "Inspector", role: "dialog" },
  { width: 812, height: 375, other: "Inspector", role: "dialog" },
] as const;

for (const { width, height, other, role } of cases) {
  test(`${width}x${height}: the Action bar stays clear of ${other}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await withShareableProject(
      async (projectPath) => {
        await openProject(page, projectPath);
        const card = page.getByRole("dialog", {
          name: "Inspector",
          exact: true,
        });
        const bar = page.getByRole("group", { name: "Selection actions" });
        await inspectSelectedClip(page, true);
        await expect(card).toBeVisible();
        await expect(bar).toBeVisible();
        const neighbour = page.getByRole(role, { name: other, exact: true });
        await expect(neighbour).toBeVisible();
        await expect
          .poll(() => overlapArea(bar, neighbour), {
            message: `The Action bar's overlap with ${other} in CSS square pixels`,
          })
          .toBe(0);
        test.info().annotations.push({
          type: `bar x ${other} overlap px2`,
          description: String(await overlapArea(bar, neighbour)),
        });
      },
      undefined,
      createScriptRecordingIdentityProject,
    );
  });
}

const layouts = [
  { width: 932, height: 430, touch: true },
  { width: 1024, height: 600, touch: true },
  { width: 820, height: 1180, touch: true },
  { width: 844, height: 530, touch: false },
] as const;

for (const { width, height, touch } of layouts) {
  test(`${width}x${height}${touch ? "" : " with a mouse"}: the Action bar, the Inspector and Timeline view stay apart`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height },
      hasTouch: touch,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    try {
      await withShareableProject(
        async (projectPath) => {
          await openProject(page, projectPath);
          await inspectSelectedClip(page, touch);
          const card = page.getByRole("dialog", {
            name: "Inspector",
            exact: true,
          });
          const bar = page.getByRole("group", { name: "Selection actions" });
          const corner = page.getByRole("group", { name: "Timeline view" });
          await expect(card).toBeVisible();
          await expect(bar).toBeVisible();
          const pairs = [
            ["bar x card", bar, card],
            ["bar x corner", bar, corner],
            ["card x corner", card, corner],
          ] as const;
          for (const [name, first, second] of pairs) {
            if (!(await second.isVisible())) continue;
            await expect
              .poll(() => overlapArea(first, second), {
                message: `${width}x${height} ${name} overlap in CSS square pixels`,
              })
              .toBe(0);
            test.info().annotations.push({
              type: `${name} overlap px2`,
              description: String(await overlapArea(first, second)),
            });
          }
        },
        undefined,
        createScriptRecordingIdentityProject,
      );
    } finally {
      await context.close();
    }
  });
}
