import { expect, test } from "@playwright/test";
import { openHostProject } from "./overlayReachability";

// The Select range toggle is a touch control in the Edit corner; isMobile makes the pointer coarse from the first paint.
test.use({ hasTouch: true, isMobile: true });

test("tablet Select range arms from the Edit corner toggle into the draft sheet and Esc disarms", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1194, height: 834 });
  await openHostProject(page);
  // The toggle follows the last pointer; opening the project used a mouse.
  await page.touchscreen.tap(1, 1);
  const toggle = page
    .getByRole("button", { name: "Select range", exact: true })
    .first();
  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-range-armed]").first()).toBeAttached();
  await expect(
    page.getByRole("region", { name: "Range fields" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-range-armed]")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});
