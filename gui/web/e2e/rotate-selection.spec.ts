import { expect, test } from "@playwright/test";
import { openHostProject } from "./overlayReachability";

/*
 * Rotating a landscape tablet to portrait swaps in the phone shell, which used to open on
 * Listen and hide the selected clip behind its Inspector sheet (#1767).
 */

test("a selected clip stays on the Timeline screen when a tablet is rotated to portrait", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1194, height: 834 });
  await openHostProject(page);
  const clip = page.locator(".clip-block").first();
  await clip.click();
  await expect(page.locator(".clip-block.selected").first()).toBeVisible();

  await page.setViewportSize({ width: 834, height: 1194 });
  await expect(page.locator(".daw-shell--phone, .daw-shell")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });

  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("button", {
      name: "Timeline",
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".clip-block.selected").first()).toBeVisible();
});

test("a phone with nothing selected still opens on Listen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHostProject(page);
  await expect(page.locator(".daw-shell--phone")).toHaveClass(
    /daw-shell--listen/,
  );
});
