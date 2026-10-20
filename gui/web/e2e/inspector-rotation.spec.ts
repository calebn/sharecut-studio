import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

test.use({ hasTouch: true });

test("rotating a phone with the Inspector open keeps the focused field on screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.locator(".lane-row .clip-block").first().click();
  await page.getByRole("button", { name: "Expand to half height" }).click();
  const field = page.getByLabel("Fade out ms");
  await expect(field).toBeAttached();
  await field.focus();
  const onScreen = async () => {
    const box = await field.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) return false;
    return (
      box.y >= 0 &&
      box.y + box.height <= viewport.height &&
      box.x >= 0 &&
      box.x + box.width <= viewport.width
    );
  };
  expect(await onScreen()).toBe(true);
  for (const size of [
    { width: 667, height: 375 },
    { width: 375, height: 667 },
  ]) {
    await page.setViewportSize(size);
    await expect(field).toBeFocused();
    await expect.poll(onScreen).toBe(true);
  }
});
