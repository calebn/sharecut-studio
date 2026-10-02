import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import { zoomTimelineIn } from "../e2e/timelineZoom";

test("short desktop lanes reach the horizontal end with classic scrollbars", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1512, height: 805 });
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.locator('.daw-shell[data-shell="desktop"]')).toBeVisible();
  await expect(page.locator(".track-header-row")).toHaveCount(2);
  await page.addStyleTag({
    content:
      ".timeline-scroll::-webkit-scrollbar { width: 0.75rem; height: 0.75rem; }",
  });
  await zoomTimelineIn(page, { maxSteps: 12, minRangePx: 100 });

  const scroll = page.locator(".timeline-scroll");
  const measured = await scroll.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    const size = element.scrollWidth;
    const client = element.clientWidth;
    const at = element.scrollLeft;
    return {
      size,
      client,
      at,
      gap: size - (at + client),
      verticalRange: element.scrollHeight - element.clientHeight,
    };
  });
  expect(measured.verticalRange, JSON.stringify(measured)).toBeLessThanOrEqual(
    0,
  );
  expect(
    measured.size - measured.client,
    JSON.stringify(measured),
  ).toBeGreaterThan(100);
  expect(measured.gap, JSON.stringify(measured)).toBeLessThanOrEqual(2);
});
