import { expect, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { switchE2eProject } from "./shareableProject";
import { openProject, phone } from "./stageNav";
import { setTheme } from "./theme";
import { newTouchPage, TRACK, touch, VIEWPORTS } from "./touchTimeline";

/** Well under TOAST_MS: a card that is gone by then was cleared, not timed out. */
const GONE_MS = 1000;

test.use({ hasTouch: true, isMobile: true });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-feedback-gesture-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

for (const theme of ["light", "dark"] as const) {
  test(`phone: a gesture's message ends with the gesture or the mode (${theme})`, async ({
    context,
  }, info) => {
    const { page, cdp } = await newTouchPage(context);
    await openProject(page, projectPath);
    for (const at_time of [10, 40, 50]) {
      await postDocumentCommand(
        page,
        "e2e-feedback-gesture",
        "SplitAtTime",
        { at_time, track_ids: [TRACK] },
        projectPath,
      );
    }
    await page.setViewportSize(VIEWPORTS.phone);
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame")).toBeVisible();
    await openPhoneTimeline(page);
    await setTheme(page, theme);
    const card = page.locator(".ui-toast-region--app .ui-toast-message", {
      hasText: "armed",
    });
    const clip = await page.evaluate(() => {
      for (const el of document.querySelectorAll(".lane-row .clip-block")) {
        const r = el.getBoundingClientRect();
        if (r.width >= 120 && r.left >= 0 && r.right <= innerWidth)
          return { x: r.left + r.width / 2, y: r.top + r.height * 0.75 };
      }
      return null;
    });
    expect(clip).not.toBeNull();
    const at = clip!;
    const arm = async () => {
      await touch(cdp, "touchStart", [at]);
      await expect(card).toBeVisible();
    };

    await arm();
    await page.screenshot({
      path: info.outputPath(`armed-${theme}.png`),
    });
    await touch(cdp, "touchEnd");
    await expect(card).toHaveCount(0, { timeout: GONE_MS });

    await arm();
    await phone.showText(page);
    await expect(card).toHaveCount(0, { timeout: GONE_MS });
    await touch(cdp, "touchEnd");
    await expect(page.locator(".ui-toast-region--app .ui-toast")).toHaveCount(
      0,
      { timeout: GONE_MS },
    );
  });
}
