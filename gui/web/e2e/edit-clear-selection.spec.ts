import { expect, type Locator, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject } from "./shareableProject";
import { armRange, goToStage, openProject, phone } from "./stageNav";
import { withDocumentCommandTypes } from "./transcriptEdit";

const LAYOUTS = [
  { name: "1280x800 mouse", width: 1280, height: 800, touch: false },
  { name: "820x1180 touch", width: 820, height: 1180, touch: true },
  { name: "390x844 touch", width: 390, height: 844, touch: true },
  { name: "320x568 touch", width: 320, height: 568, touch: true },
  { name: "844x390 touch", width: 844, height: 390, touch: true },
];

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-clear-sel-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

const bar = (page: Page) =>
  page.getByRole("group", { name: /^(Selection|Edit) actions$/ });
const clearIn = (page: Page) =>
  bar(page).getByRole("button", { name: "Clear selection", exact: true });

async function press(target: Locator, touch: boolean) {
  if (touch) await target.tap();
  else await target.click();
}

async function selectClip(page: Page, touch: boolean): Promise<Locator> {
  await openProject(page, projectPath);
  await goToStage(page, "edit");
  if (touch) await phone.showTimeline(page);
  const clip = page.locator(".clip-hit").first();
  await press(clip, touch);
  await expect(clip).toHaveAttribute("aria-pressed", "true");
  return clip;
}

async function dragRange(page: Page, touch: boolean): Promise<void> {
  await openProject(page, projectPath);
  await goToStage(page, "edit");
  if (touch) await phone.showTimeline(page);
  await armRange(page);
  const lane = page.locator('.lane-row[data-track-id="reference"]').first();
  const box = await lane.boundingBox();
  if (!box) throw new Error("reference lane has no box");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 6 });
  await page.mouse.up();
  await expect(clearIn(page)).toBeVisible();
}

async function expectReachable(page: Page, clear: Locator, touch: boolean) {
  await expect(clear).toBeInViewport({ ratio: 1 });
  if (!touch) return;
  const bounds = await clear.boundingBox();
  expect(bounds?.width).toBeGreaterThanOrEqual(44);
  expect(bounds?.height).toBeGreaterThanOrEqual(44);
}

for (const { name, width, height, touch } of LAYOUTS) {
  test.describe(`Clear selection in the Action bar at ${name}`, () => {
    test.use({ viewport: { width, height }, hasTouch: touch });

    test("clears a selected clip without a document command and leaves focus on the clip", async ({
      page,
    }) => {
      const clip = await selectClip(page, touch);
      await withDocumentCommandTypes(page, async (commands) => {
        const clear = clearIn(page);
        await expectReachable(page, clear, touch);
        await press(clear, touch);
        await expect(clip).toHaveAttribute("aria-pressed", "false");
        await expect(clearIn(page)).toHaveCount(0);
        await expect(clip).toBeFocused();
        expect(commands).toEqual([]);

        await press(clip, touch);
        await expect(clip).toHaveAttribute("aria-pressed", "true");
        await press(clearIn(page), touch);
        await expect(clip).toHaveAttribute("aria-pressed", "false");
        expect(commands).toEqual([]);
      });
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        /aligned dialogue/i,
      );
    });

    test("clears a drawn range in one press", async ({ page }) => {
      await dragRange(page, touch);
      await withDocumentCommandTypes(page, async (commands) => {
        const clear = clearIn(page);
        await expectReachable(page, clear, touch);
        await press(clear, touch);
        await expect(clearIn(page)).toHaveCount(0);
        await expect(page.locator(".lane-row .range-overlay")).toHaveCount(0);
        expect(commands).toEqual([]);
      });
    });

    test("Escape still clears the selection", async ({ page }) => {
      const clip = await selectClip(page, touch);
      await expect(clearIn(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(clip).toHaveAttribute("aria-pressed", "false");
      await expect(clearIn(page)).toHaveCount(0);
    });
  });
}

test.describe("Clear selection at 200% text", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("stays reachable at 44 px", async ({ page }) => {
    const clip = await selectClip(page, true);
    const enlarged = await page.addStyleTag({
      content: "html { font-size: 200%; }",
    });
    const clear = clearIn(page);
    await expectReachable(page, clear, true);
    await clear.tap();
    await expect(clip).toHaveAttribute("aria-pressed", "false");
    await enlarged.evaluate((node) => node.parentNode?.removeChild(node));
  });
});

test.describe("the 320 px dock keeps every control reachable", () => {
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true });

  async function expectDockFits(page: Page) {
    const dock = bar(page);
    await expect(dock).toBeVisible();
    const fits = await dock
      .locator(".sys-dock-slot--start")
      .evaluate((slot) => slot.scrollWidth <= slot.clientWidth + 1);
    expect(fits, "the verbs fit without scrolling").toBe(true);
    for (const button of await dock.getByRole("button").all())
      await expect(button).toBeInViewport({ ratio: 1 });
  }

  test("a clip", async ({ page }) => {
    await selectClip(page, true);
    await expectDockFits(page);
  });

  test("a range", async ({ page }) => {
    await dragRange(page, true);
    await expectDockFits(page);
  });

  test("a track", async ({ page }) => {
    await openProject(page, projectPath);
    await phone.showTimeline(page);
    await page.locator(".sys-track-main").first().tap();
    const sheet = page.getByRole("dialog", { name: "Inspector", exact: true });
    await sheet.getByRole("button", { name: "Close", exact: true }).tap();
    await expect(sheet).toHaveCount(0);
    await expectDockFits(page);
    await expect(clearIn(page)).toBeVisible();
  });
});
