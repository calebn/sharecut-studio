import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

test.describe("Sharecut Studio mobile smoke", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("phone shell shows mode nav and is axe-clean", async ({ page }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);

    await expect(page.locator(".daw-shell--phone")).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Primary" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Listen" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Text" })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Primary" }).getByRole("button", {
        name: "More",
      }),
    ).toBeVisible();
    await expect(page.locator("header.transport")).toHaveCount(0);
    await expect(page.locator(".mobile-listen-transport")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toBeAttached();

    const shell = page.locator(".daw-shell--phone");
    const listenBody = page.locator(".mobile-mode-body");
    const shellBox = await shell.boundingBox();
    const listenBodyBox = await listenBody.boundingBox();
    expect(shellBox).toBeTruthy();
    expect(listenBodyBox).toBeTruthy();
    expect(listenBodyBox!.y).toBeLessThanOrEqual(shellBox!.y + 1);

    await page.getByRole("button", { name: "Timeline" }).click();
    await expect(page.locator(".timeline-area--fixed-playhead")).toBeVisible();
    await expect(page.locator("header.transport")).toHaveCount(1);
    const timelineBodyBox = await listenBody.boundingBox();
    expect(timelineBodyBox).toBeTruthy();
    expect(timelineBodyBox!.y).toBeGreaterThan(shellBox!.y);

    await page.getByRole("button", { name: "Text" }).click();
    await expect(page.locator(".mobile-text-mode")).toBeVisible();

    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "More" })
      .click();
    await expect(page.locator(".mobile-more-hub")).toBeVisible();

    // Primary chrome stays in viewport (not cropped)
    const comment = page.getByRole("button", { name: "Comment", exact: true });
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(comment).toBeVisible();
    await expect(menu).toBeVisible();
    const vw = page.viewportSize()?.width ?? 390;
    for (const loc of [comment, menu]) {
      const box = await loc.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 1);
    }

    await expectPageAxeClean(page);
  });
});
