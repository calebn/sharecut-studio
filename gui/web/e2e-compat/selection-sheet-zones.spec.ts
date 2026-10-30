import { expect, type Page, test } from "@playwright/test";
import { openHostProject } from "../e2e/overlayReachability";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { inspectSelection } from "../e2e/stageNav";

test.use({ hasTouch: true, actionTimeout: 15_000 });

async function expectZonesLaidOutLikeTheInspector(
  page: Page,
  { width, height }: { width: number; height: number },
) {
  await page.addInitScript(() => {
    localStorage.setItem("sharecut.compactInspector", "half");
  });
  await page.setViewportSize({ width, height });
  await openHostProject(page);
  if (width <= 767) await openPhoneTimeline(page);
  await page.locator(".clip-hit").first().tap();
  await inspectSelection(page);
  await expect(page.locator(".related-commands-zone").first()).toBeVisible();
  const layout = await page.evaluate(() => {
    const box = (el: Element) => el.getBoundingClientRect();
    const inspector = document.querySelector<HTMLElement>(
      ".bottom-sheet .inspector, .sys-inspector .inspector",
    )!;
    const gutter =
      box(inspector).left +
      Number.parseFloat(getComputedStyle(inspector).paddingLeft);
    return {
      gutter,
      zones: [
        ...document.querySelectorAll(
          ".bottom-sheet .related-commands-list, .sys-inspector .related-commands-list",
        ),
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
}

test("the phone sheet lays its related and more zones out like the inspector above them", async ({
  page,
}) => {
  await expectZonesLaidOutLikeTheInspector(page, { width: 390, height: 844 });
});

test("the tablet sheet lays its related and more zones out like the inspector above them", async ({
  page,
}) => {
  await expectZonesLaidOutLikeTheInspector(page, { width: 820, height: 1180 });
});
