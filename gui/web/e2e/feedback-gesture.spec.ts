import { expect, test } from "@playwright/test";
import { LONG_PRESS_MS } from "../src/hooks/gestureConstants";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject } from "./shareableProject";
import {
  buildFixture,
  newTouchPage,
  openTimeline,
  touch,
} from "./touchTimeline";

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
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await buildFixture(page, projectPath, "e2e-feedback-gesture");
    await openTimeline(page, projectPath, "phone", theme);
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
      await page.waitForTimeout(LONG_PRESS_MS + 150);
      await expect(card).toBeVisible();
    };

    await arm();
    await page.screenshot({
      path: info.outputPath(`armed-${theme}.png`),
    });
    await touch(cdp, "touchEnd");
    await expect(card).toHaveCount(0);

    await arm();
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Text" })
      .click();
    await expect(card).toHaveCount(0);
    await touch(cdp, "touchEnd");
    await expect(page.locator(".ui-toast-region--app .ui-toast")).toHaveCount(
      0,
    );
  });
}
