import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openProject } from "./stageNav";

test.describe("control state parity", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("the pressed mix side keeps its fill on hover", async ({ page }) => {
    await openProject(page, e2eProjectPath);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );

    const paint = (locator: ReturnType<typeof page.getByRole>) =>
      locator.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          bg: cs.backgroundColor,
          image: cs.backgroundImage,
          color: cs.color,
        };
      });

    const mix = page
      .getByRole("group", { name: "Audition" })
      .getByRole("button", { name: "B", exact: true });
    await expect(mix).toHaveAttribute("aria-pressed", "true");
    await page.mouse.move(0, 0);
    const mixRest = await paint(mix);
    await mix.hover();
    const mixHover = await paint(mix);
    expect(mixHover.bg).toBe(mixRest.bg);
    expect(mixHover.image).toBe(mixRest.image);
    expect(mixHover.color).toBe(mixRest.color);

    expect(mixRest.image).toBe("none");
  });
});
