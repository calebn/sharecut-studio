import { expect, type Page, test } from "@playwright/test";
import { openHostProject } from "../e2e/overlayReachability";
import { openPhoneTimeline } from "../e2e/phoneTimeline";

test.use({ hasTouch: true, actionTimeout: 15_000 });

const SHEETS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
] as const;

async function openClipSheet(
  page: Page,
  { width, height }: { width: number; height: number },
  detent: "peek" | "half",
) {
  await page.addInitScript((view) => {
    localStorage.setItem("sharecut.compactInspector", view);
  }, detent);
  await page.setViewportSize({ width, height });
  await openHostProject(page);
  if (width <= 767) await openPhoneTimeline(page);
  await page.locator(".clip-hit").first().tap();
  await expect(page.locator(".bottom-sheet")).toBeVisible();
}

for (const sheet of SHEETS) {
  test(`the ${sheet.name} sheet lays its related and more zones out like the inspector above them`, async ({
    page,
  }) => {
    await openClipSheet(page, sheet, "half");
    await expect(page.locator(".related-commands-zone").first()).toBeVisible();
    const layout = await page.evaluate(() => {
      const box = (el: Element) => el.getBoundingClientRect();
      const inspector = document.querySelector<HTMLElement>(
        ".bottom-sheet .inspector",
      )!;
      const gutter =
        box(inspector).left +
        Number.parseFloat(getComputedStyle(inspector).paddingLeft);
      return {
        gutter,
        zones: [
          ...document.querySelectorAll(".bottom-sheet .related-commands-list"),
        ].map((list) => ({
          direction: getComputedStyle(list).flexDirection,
          display: getComputedStyle(list).display,
          buttons: [...list.querySelectorAll("button")].map((b) => ({
            left: box(b).left,
            top: Math.round(box(b).top),
          })),
        })),
      };
    });
    expect(layout.zones.length).toBeGreaterThan(0);
    for (const zone of layout.zones) {
      expect(zone.display).toBe("flex");
      expect(zone.direction).toBe("row");
      expect(zone.buttons.length).toBeGreaterThan(0);
      expect(zone.buttons[0]!.left).toBeGreaterThanOrEqual(layout.gutter);
      if (zone.buttons.length > 1) {
        expect(zone.buttons[1]!.top).toBe(zone.buttons[0]!.top);
      }
    }
  });
}
