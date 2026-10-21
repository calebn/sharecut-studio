import { expect, test } from "@playwright/test";
import { withShareableProject } from "./shareableProject";

/**
 * #1982: Listen opens with Play visible and pressable, with no scrolling, on
 * every phone size and orientation (phone shell, width up to 767). A short landscape window used to leave
 * Play under the comment field.
 */
const PHONES = [
  { name: "320x460 portrait", width: 320, height: 460 },
  { name: "320x568 portrait", width: 320, height: 568 },
  { name: "375x547 portrait (iPhone SE)", width: 375, height: 547 },
  { name: "390x844 portrait", width: 390, height: 844 },
  { name: "460x320 landscape", width: 460, height: 320 },
  { name: "568x320 landscape", width: 568, height: 320 },
  { name: "667x375 landscape", width: 667, height: 375 },
] as const;

test.use({
  hasTouch: true,
  storageState: { cookies: [], origins: [] },
});

for (const phone of PHONES) {
  test(`Play is visible without scrolling at ${phone.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await withShareableProject(async (projectPath) => {
      await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
      const play = page.getByRole("button", { name: "Play", exact: true });
      await expect(play).toBeVisible();
      await expect(async () => {
        const box = await play.boundingBox();
        expect(box).not.toBeNull();
        if (!box) return;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(phone.height);
        const dock = await page.locator(".mobile-dock").boundingBox();
        expect(dock).not.toBeNull();
        if (dock) expect(box.y + box.height).toBeLessThanOrEqual(dock.y + 0.5);
        const hero = await page.locator(".listen-hero").boundingBox();
        expect(hero).not.toBeNull();
        if (hero) {
          expect(box.y).toBeGreaterThanOrEqual(hero.y);
          expect(box.y + box.height).toBeLessThanOrEqual(hero.y + hero.height);
        }
        const hit = await play.evaluate(
          (el, { x, y }) => el.contains(document.elementFromPoint(x, y)),
          { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        );
        expect(hit).toBe(true);
      }).toPass();
    });
  });
}
