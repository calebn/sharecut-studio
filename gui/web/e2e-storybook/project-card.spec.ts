import { AxeBuilder } from "@axe-core/playwright";
import { devices, expect, test } from "@playwright/test";
import { storyUrl } from "./storyUrl";

for (const theme of ["light", "dark"] as const) {
  test(`Home phone row swipe-revealed Remove from list is axe clean and named from its label in ${theme}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      ...devices["Pixel 5"],
      viewport: { width: 390, height: 844 },
      baseURL: "http://127.0.0.1:6010",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(storyUrl("stages-home-home--phone", { theme }));
    const row = page.locator(".sys-project").first();
    await expect(row).toBeVisible();
    const cdp = await context.newCDPSession(page);
    const at = await row.boundingBox();
    if (!at) throw new Error("Row not rendered");
    const from = { x: at.x + at.width - 40, y: at.y + at.height / 2 };
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [from],
    });
    for (let step = 1; step <= 12; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from.x - (step * 100) / 12, y: from.y }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(row).toHaveAttribute("data-revealed", "true");
    const remove = row.locator(".sys-project-remove");
    const label = await remove.getAttribute("aria-label");
    expect(label).toMatch(/^Remove from list, \S/);
    expect(await remove.innerText()).toBe("Remove from list");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      results.violations,
      JSON.stringify(results.violations, null, 2),
    ).toEqual([]);
    await context.close();
  });
}
