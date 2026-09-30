import { fileURLToPath, pathToFileURL } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const splashUrl = pathToFileURL(
  fileURLToPath(new URL("../../desktop/splash/index.html", import.meta.url)),
).href;

for (const width of [360, 820]) {
  for (const theme of ["light", "dark"]) {
    test(`native startup and long errors fit ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 740 });
      await page.goto(splashUrl);
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(page.getByRole("status")).toHaveText(
        "Starting Sharecut Studio…",
      );
      await page.getByRole("status").evaluate((element) => {
        element.textContent =
          "Unable to start the local engine. " + "/Users/recording/".repeat(40);
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
