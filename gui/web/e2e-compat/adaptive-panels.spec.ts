import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { e2eProjectPath, repoRoot } from "../e2e/env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { switchE2eProject } from "../e2e/shareableProject";
import { setTheme, withAppearance } from "../e2e/theme";

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

for (const { theme, reducedMotion } of withAppearance([0, 1])) {
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
      await page.emulateMedia({
        reducedMotion: reducedMotion ? "reduce" : "no-preference",
      });
      await page.addInitScript((selectedTheme) => {
        localStorage.setItem("daw_theme", selectedTheme);
        localStorage.setItem("sharecut.homeScreenHintDismissed", "1");
      }, theme);
      await page.goto(`/?project=${encodeURIComponent(fixture.projectPath)}`);
      await setTheme(page, theme);
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
      await expect(toggle).toHaveText("Panels");
      await expect(handle).toHaveCount(0);
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
      await expect(toggle).toHaveText("Panels");
      await toggle.tap();
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

for (const { cell: rootPx, theme, reducedMotion } of withAppearance([16, 32])) {
  test(`adaptive Panels leaves tool rail targets clear at root${rootPx} ${theme}`, async ({
    page,
  }) => {
    const fixture = createRelocatedE2eProject(
      "sharecut-e2e-adaptive-rail-",
      undefined,
      path.join(repoRoot, "tests/fixtures/sharecut_ux_demo"),
    );
    try {
      await switchE2eProject(fixture.projectPath);
      await page.setViewportSize({ width: 844, height: 390 });
      await page.emulateMedia({
        reducedMotion: reducedMotion ? "reduce" : "no-preference",
      });
      await page.addInitScript(() =>
        localStorage.setItem("sharecut.homeScreenHintDismissed", "1"),
      );
      await page.goto(`/?project=${encodeURIComponent(fixture.projectPath)}`);
      await setTheme(page, theme);
      await expect(page.locator(".track-header-row")).toHaveCount(2);
      await page.evaluate(() => document.fonts.ready);
      await page.locator("html").evaluate((html, size) => {
        html.style.fontSize = `${size}px`;
      }, rootPx);
      const controls = page.locator(
        ".layout-toggle-btn,.tool-rail button,.editing-tool-rail button",
      );
      let visible = 0;
      for (const control of await controls.all()) {
        if (!(await control.isVisible())) continue;
        visible++;
        expect(
          await control.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return [0.1, 0.5, 0.9].every((x) =>
              [0.1, 0.5, 0.9].every((y) =>
                element.contains(
                  document.elementFromPoint(
                    box.x + box.width * x,
                    box.y + box.height * y,
                  ),
                ),
              ),
            );
          }),
        ).toBe(true);
      }
      expect(visible).toBeGreaterThan(1);
      const toggle = page.locator(".layout-toggle-btn");
      await expect(toggle).toHaveAccessibleName("Show editor panels");
      await expect(toggle).toHaveText("Panels");
      await expect(page.locator(".drawer-reopen-handle")).toHaveCount(0);
      const box = await toggle.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual((44 * rootPx) / 16);
      expect(box!.height).toBeGreaterThanOrEqual((44 * rootPx) / 16);
      await toggle.tap();
      await expect(
        page.getByRole("region", { name: "Editor panels" }),
      ).toBeVisible();
    } finally {
      await switchE2eProject(e2eProjectPath);
      removeRelocatedE2eProject(fixture.workspaceDir);
    }
  });
}
