import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { e2eProjectPath, repoRoot } from "../e2e/env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { switchE2eProject } from "../e2e/shareableProject";

test.use({ hasTouch: true, isMobile: true });

async function expectTouchable(page: Page, control: Locator) {
  const bounds = await control.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThanOrEqual(44);
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  const scrollport = await page.locator(".timeline-scroll").boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(scrollport!.y);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
    scrollport!.y + scrollport!.height,
  );
  expect(
    await control.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        ),
      );
    }),
  ).toBe(true);
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme} fresh short landscape exposes both tracks and explicit panel access`, async ({
    page,
  }) => {
    const fixture = createRelocatedE2eProject(
      "sharecut-e2e-adaptive-panels-",
      undefined,
      path.join(repoRoot, "tests/fixtures/sharecut_ux_demo"),
    );
    try {
      await switchE2eProject(fixture.projectPath);
      await page.setViewportSize({ width: 844, height: 390 });
      await page.addInitScript((selectedTheme) => {
        localStorage.setItem("daw_theme", selectedTheme);
        localStorage.setItem("sharecut.homeScreenHintDismissed", "1");
      }, theme);
      await page.goto(`/?project=${encodeURIComponent(fixture.projectPath)}`);
      await expect(page.locator(".daw-shell--tablet")).toBeVisible();
      await expect(page.locator(".track-header-row")).toHaveCount(2);
      await page.evaluate(() => document.fonts.ready);
      const scroller = page.locator(".timeline-scroll");
      const panels = page.getByRole("region", { name: "Editor panels" });
      const toggle = page.locator(".layout-toggle-btn");
      const handle = page.locator(".drawer-reopen-handle");
      await expect(toggle).toHaveAccessibleName("Show editor panels");
      await expect(panels).toBeHidden();
      await page.getByRole("button", { name: "Menu", exact: true }).tap();
      await expect(
        page.getByRole("menuitemradio", {
          name: "Maximize timeline",
          exact: true,
        }),
      ).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
      await expect(handle).toHaveText("Show editor panels");
      await expect(handle).toBeVisible();
      await expect(scroller).toHaveJSProperty("scrollTop", 0);
      for (const track of ["reference", "guest"]) {
        const identity = page
          .locator(".clip-label")
          .filter({ hasText: new RegExp(`^${track} ·`) })
          .first();
        await expect(identity).toBeVisible();
        expect(
          await identity.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
        const identityBox = await identity.boundingBox();
        const timelineBox = await scroller.boundingBox();
        expect(identityBox!.y).toBeGreaterThanOrEqual(timelineBox!.y);
        expect(identityBox!.y + identityBox!.height).toBeLessThanOrEqual(
          timelineBox!.y + timelineBox!.height,
        );
        for (const action of ["Mute", "Solo"]) {
          const button = page.getByRole("button", {
            name: `${action} ${track}`,
            exact: true,
          });
          await expectTouchable(page, button);
          await button.tap();
          await expect(button).toHaveAttribute("aria-pressed", "true");
          await button.tap();
          await expect(button).toHaveAttribute("aria-pressed", "false");
          await expect(scroller).toHaveJSProperty("scrollTop", 0);
        }
      }
      await page.setViewportSize({ width: 844, height: 600 });
      await expect(panels).toBeVisible();
      await expect(toggle).toHaveAccessibleName("Maximize timeline");
      await page.getByRole("button", { name: "Menu", exact: true }).tap();
      await expect(
        page.getByRole("menuitemradio", {
          name: "Default layout",
          exact: true,
        }),
      ).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
      expect(
        await page.evaluate(() =>
          localStorage.getItem("sharecut.tabsCollapsed"),
        ),
      ).toBeNull();
      await page.setViewportSize({ width: 844, height: 390 });
      await expect(handle).toBeVisible();
      await handle.tap();
      await expect(panels).toBeVisible();
      await expect(toggle).toHaveAccessibleName("Maximize timeline");
      await page.setViewportSize({ width: 844, height: 600 });
      await page.setViewportSize({ width: 844, height: 390 });
      await expect(panels).toBeVisible();
      await toggle.tap();
      await expect(panels).toBeHidden();
      await expect(toggle).toHaveAccessibleName("Restore layout");
      await page.reload();
      await expect(toggle).toHaveAccessibleName("Restore layout");
      await toggle.tap();
      await expect(panels).toBeVisible();
      await page.reload();
      await expect(toggle).toHaveAccessibleName("Show editor panels");
    } finally {
      await switchE2eProject(e2eProjectPath);
      removeRelocatedE2eProject(fixture.workspaceDir);
    }
  });
}
