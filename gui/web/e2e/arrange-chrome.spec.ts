import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { parseTimecodeSec } from "./timecode";

test.describe("Arrange chrome", () => {
  test("empty-canvas ruler extends past session while End seeks session", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );

    const ruler = page.getByRole("slider", { name: "Timeline position" });
    await expect(ruler).toBeVisible();
    const sessionMax = Number(await ruler.getAttribute("aria-valuemax"));
    expect(sessionMax).toBeGreaterThan(0);

    await ruler.click();
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("-");
    }

    const lastTick = page.locator(".ruler-tick").last();
    await expect(lastTick).toBeVisible();
    const lastLabel = await lastTick.innerText();
    // Ruler labels carry the decimals their step needs: one when zoomed out.
    expect(lastLabel).toMatch(/^\d+:\d{2}\.\d$/);
    const lastSec = parseTimecodeSec(lastLabel);
    expect(lastSec).toBeGreaterThan(sessionMax - 1);

    await page.keyboard.press("Home");
    expect(Number(await ruler.getAttribute("aria-valuenow"))).toBe(0);
    await page.keyboard.press("End");
    expect(Number(await ruler.getAttribute("aria-valuenow"))).toBeCloseTo(
      sessionMax,
      1,
    );

    await page.getByRole("button", { name: "Fit", exact: true }).click();
    const fitWidth = await ruler.evaluate(
      (el) => el.getBoundingClientRect().width,
    );
    expect(fitWidth).toBeGreaterThan(100);
  });

  test("splitter Home does not seek the playhead", async ({ page }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );

    const ruler = page.getByRole("slider", { name: "Timeline position" });
    await ruler.click();
    await page.keyboard.press("End");
    const atEnd = Number(await ruler.getAttribute("aria-valuenow"));
    expect(atEnd).toBeGreaterThan(0);

    const splitter = page.getByRole("separator", {
      name: "Resize editor panels",
    });
    await splitter.focus();
    await page.keyboard.press("Home");
    expect(Number(await ruler.getAttribute("aria-valuenow"))).toBe(atEnd);
  });

  test("track reorder handles are present for drag", async ({ page }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const handles = page.getByRole("button", { name: /Reorder track/i });
    await expect(handles.first()).toBeVisible();
    const count = await handles.count();
    expect(count).toBeGreaterThan(1);
  });
});
