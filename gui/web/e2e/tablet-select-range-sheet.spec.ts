import { expect, test } from "@playwright/test";
import { openHostProject } from "./overlayReachability";

/*
 * Doing controls sit in the bottom zone (#1793): on a tablet, arming Select range opens the selection
 * sheet with In, Out, the track checkboxes, Select range and Cancel inside it, not a card at the top.
 */

test("tablet Select range puts In, Out, Select range and Cancel in the sheet at the bottom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1194, height: 834 });
  await openHostProject(page);
  await page
    .getByRole("button", { name: "Select range", exact: true })
    .first()
    .click();

  const sheet = page.getByRole("dialog", { name: "Inspector", exact: true });
  const actions = sheet.getByRole("region", { name: "Range actions" });
  await expect(actions).toBeVisible();
  await expect(actions.getByLabel("In")).toBeVisible();
  await expect(actions.getByLabel("Out")).toBeVisible();
  await expect(
    actions.getByRole("button", { name: "Select range", exact: true }),
  ).toBeVisible();
  const cancel = actions.getByRole("button", {
    name: "Cancel range selection",
  });
  await expect(cancel).toBeVisible();

  // Nothing of it hangs under the App header at the top.
  await expect(
    page.locator(".stage-frame-header").getByRole("region", {
      name: "Range actions",
    }),
  ).toHaveCount(0);
  // The sheet sits below the lanes it selects across, so they stay in view.
  // Poll: the sheet's slide-in settles before the lanes are measured.
  await expect
    .poll(async () => {
      const sheetBox = await sheet.boundingBox();
      if (!sheetBox) return 0;
      const bottoms = await page
        .locator(".lane-row")
        .evaluateAll((rows) =>
          rows.map((row) => row.getBoundingClientRect().bottom),
        );
      return bottoms.filter((bottom) => bottom <= sheetBox.y + 1).length;
    })
    .toBeGreaterThanOrEqual(2);

  await cancel.click();
  await expect(actions).toHaveCount(0);
});
