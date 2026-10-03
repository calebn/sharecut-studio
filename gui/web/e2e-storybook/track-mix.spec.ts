import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "../e2e/axe";

for (const theme of ["light", "dark"]) {
  for (const width of [320, 360]) {
    test(`Mix rows and controls fit ${width} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 });
      await page.goto(
        `/iframe.html?id=templates-trackmix--phone-360&viewMode=story&globals=theme:${theme}`,
      );
      await expect(page.getByRole("listitem")).toHaveCount(6);
      await page.evaluate(() => document.fonts.ready);
      const geometry = await page.locator(".track-mix").evaluate((el) => ({
        width: el.clientWidth,
        scroll: el.scrollWidth,
        rows: [...el.querySelectorAll(".track-mix-row")].map(
          (row) => row.getBoundingClientRect().height,
        ),
        targets: [...el.querySelectorAll("button,input")].map((control) => {
          const r = control.getBoundingClientRect();
          return { width: r.width, height: r.height };
        }),
      }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
      expect(geometry.rows).toEqual([56, 56, 56, 56, 56, 56]);
      for (const target of geometry.targets) {
        expect(target.width).toBeGreaterThanOrEqual(44);
        expect(target.height).toBeGreaterThanOrEqual(44);
      }
      await expectPageAxeClean(page);
      const strictMix = await new AxeBuilder({ page })
        .include(".track-mix")
        .analyze();
      expect(
        strictMix.violations,
        JSON.stringify(strictMix.violations, null, 2),
      ).toEqual([]);
      await page.screenshot({
        path: test.info().outputPath(`mix-${width}-${theme}.png`),
      });
    });
  }
  test(`Mix long names, many tracks and text zoom in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    for (const story of [
      "long-names",
      "many-tracks",
      "read-only",
      "empty",
      "loading",
    ]) {
      await page.goto(
        `/iframe.html?id=templates-trackmix--${story}&viewMode=story&globals=theme:${theme}`,
      );
      await expect(page.locator(".track-mix")).toBeVisible();
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
      });
      const geometry = await page
        .locator(".track-mix")
        .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
      await expectPageAxeClean(page);
      const strictMix = await new AxeBuilder({ page })
        .include(".track-mix")
        .analyze();
      expect(
        strictMix.violations,
        JSON.stringify(strictMix.violations, null, 2),
      ).toEqual([]);
    }
  });
}
