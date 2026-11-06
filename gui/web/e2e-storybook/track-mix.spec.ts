import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "../e2e/axe";
import { storyUrl } from "./storyUrl";

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 360]) {
    test(`Mix rows and controls fit ${width} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 });
      await page.goto(storyUrl("templates-trackmix--phone-360", { theme }));
      await expect(page.getByRole("listitem")).toHaveCount(6);
      await page.evaluate(() => document.fonts.ready);
      const geometry = await page.locator(".track-mix").evaluate((el) => ({
        width: el.clientWidth,
        scroll: el.scrollWidth,
        rows: [...el.querySelectorAll(".track-mix-row")].map(
          (row) => row.getBoundingClientRect().height,
        ),
        targets: [
          ...el.querySelectorAll('button,input,[role="spinbutton"]'),
        ].map((control) => {
          const r = control.getBoundingClientRect();
          return { width: r.width, height: r.height };
        }),
        resetContained: [...el.querySelectorAll(".sys-scrub-reset")].every(
          (control) => {
            const reset = control.getBoundingClientRect();
            const row = control
              .closest(".track-mix-row")
              ?.getBoundingClientRect();
            return Boolean(
              row &&
                reset.left >= row.left &&
                reset.right <= row.right &&
                reset.top >= row.top &&
                reset.bottom <= row.bottom,
            );
          },
        ),
      }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
      expect(geometry.rows).toEqual([56, 56, 56, 56, 56, 56]);
      expect(geometry.resetContained).toBe(true);
      for (const target of geometry.targets) {
        expect(target.width).toBeGreaterThanOrEqual(44);
        expect(target.height).toBeGreaterThanOrEqual(44);
      }
      if (width === 360 && theme === "light") {
        const volume = page.getByRole("spinbutton", {
          name: "Volume Mira voice",
        });
        await expect(volume).toHaveAttribute("aria-valuenow", "-3");
        const reset = page
          .getByRole("listitem")
          .filter({ hasText: "Mira voice" })
          .locator(".sys-scrub-reset");
        await expect(reset).toBeVisible();
        const input = page.locator(".sys-scrub-input");
        const expectNumberAndUnitToFit = async () => {
          const contained = await volume.evaluate((box) => {
            const bounds = box.getBoundingClientRect();
            return [
              ...box.querySelectorAll(".sys-scrub-value, .sys-scrub-unit"),
            ].every((text) => {
              const textBounds = text.getBoundingClientRect();
              return (
                textBounds.left >= bounds.left &&
                textBounds.right <= bounds.right
              );
            });
          });
          expect(contained).toBe(true);
        };
        await volume.press("Enter");
        await expect(input).toBeVisible();
        await input.fill("-60");
        await input.press("Enter");
        await expect(volume).toHaveAttribute("aria-valuenow", "-60");
        await expectNumberAndUnitToFit();
        await volume.press("Enter");
        await input.fill("12");
        await input.press("Enter");
        await expect(volume).toHaveAttribute("aria-valuenow", "12");
        await expectNumberAndUnitToFit();
        await reset.click();
        await expect(volume).toHaveAttribute("aria-valuenow", "0");
        await expect(reset).toHaveCount(0);
        await volume.press("Enter");
        await expect(input).toBeVisible();
        await input.press("Escape");
        await expect(volume).toBeVisible();
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
      await page.goto(storyUrl(`templates-trackmix--${story}`, { theme }));
      await expect(page.locator(".track-mix")).toBeVisible();
      if (story === "read-only") {
        const strictMix = await new AxeBuilder({ page })
          .include(".track-mix")
          .analyze();
        expect(
          strictMix.violations,
          JSON.stringify(strictMix.violations, null, 2),
        ).toEqual([]);
      }
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
