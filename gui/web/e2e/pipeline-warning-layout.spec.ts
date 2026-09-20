import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

const missingModelPath =
  "/very-long-project-directory-name/with-a-deeply-nested-model-cache/that-must-wrap-at-tablet-width/rnnoise-model-weights.bin";
const bootstrapCommand = "podcast bootstrap --component rnnoise";

test.describe("Pipeline bootstrap warning layout", () => {
  test("wraps a missing-model warning at tablet width", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.route("**/api/pipeline/config**", async (route) => {
      const response = await page.request.get(route.request().url());
      const config = (await response.json()) as {
        components: Record<
          string,
          { ok: boolean; hint?: string; bootstrap?: string }
        >;
      };

      await route.fulfill({
        response,
        json: {
          ...config,
          components: {
            ...config.components,
            rnnoise: {
              ...config.components.rnnoise,
              ok: false,
              hint: missingModelPath,
              bootstrap: bootstrapCommand,
            },
          },
        },
      });
    });

    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await page
      .getByLabel("Editor panels")
      .getByRole("button", { name: "Pipeline", exact: true })
      .click();

    const warning = page.locator(".pipeline-components li", {
      hasText: "Missing rnnoise",
    });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(missingModelPath);
    await expect(warning).toContainText(bootstrapCommand);
    const widths = await warning.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth + 1);
  });
});
