import { expect, type Locator, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

const TOUCH_FLOOR = 44;

async function expectTouchSized(target: Locator, label: string) {
  await expect(target, label).toBeVisible();
  const box = (await target.boundingBox())!;
  expect(box.width, `${label} width`).toBeGreaterThanOrEqual(TOUCH_FLOOR);
  expect(box.height, `${label} height`).toBeGreaterThanOrEqual(TOUCH_FLOOR);
}

test.describe("coarse-pointer touch floor (#1422)", () => {
  test.use({ hasTouch: true });

  test("tablet track rail: + Track and the reorder grip are 44px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    await expect(
      page.locator('.timeline-scroll .track-headers:not([aria-busy="true"])'),
    ).toBeVisible();
    await expectTouchSized(page.locator(".track-add-row"), "+ Track");
    await expectTouchSized(
      page.locator(".track-reorder-handle").first(),
      "track reorder grip",
    );
    // The grip's gutter leaves the track name clear of it.
    const grip = (await page
      .locator(".track-reorder-handle")
      .first()
      .boundingBox())!;
    const name = (await page
      .locator(".track-header-row.reorderable .track-title-text")
      .first()
      .boundingBox())!;
    expect(name.x).toBeGreaterThanOrEqual(grip.x + grip.width);
  });

  test("phone Listen: Open all comments is 44px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expectTouchSized(
      page.getByRole("button", { name: "Open all", exact: true }),
      "Open all",
    );
  });
});
