import { expect, type Page, type TestInfo } from "@playwright/test";
import { openAt, projectPath, SIZES, test } from "../e2e/compactChromeFixture";
import { historyHead } from "../e2e/documentCommand";
import { inspectSelectionByKey } from "../e2e/stageNav";
import { json, lane } from "../e2e/touchTimeline";

test.use({ hasTouch: true, reducedMotion: "reduce" });

const SHORT = { width: 667, height: 375 };

async function openPointInspector(page: Page) {
  await openAt(page, SIZES.portrait);
  const point = page.locator(`${lane} [data-hit-id="env-c"]`);
  await point.focus();
  await page.keyboard.press("Enter");
  await inspectSelectionByKey(page);

  const inspector = page.locator('.sys-inspector--phone[role="dialog"]');
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute("data-detent", "half");
  await expect(point).toHaveAttribute("data-selected");

  return { inspector, point };
}

async function viewportState(page: Page) {
  return page
    .locator('.sys-inspector--phone[role="dialog"]')
    .evaluate((sheet) => {
      const field = (name: string) =>
        sheet
          .querySelector(`[role="spinbutton"][aria-label="${name}"]`)
          ?.getAttribute("aria-valuenow");

      return {
        viewport: { width: innerWidth, height: innerHeight },
        detent: sheet.getAttribute("data-detent"),
        dockCount: sheet.querySelectorAll(".sys-actions--dock").length,
        time: field("Time"),
        level: field("Level"),
      };
    });
}

async function exerciseViewportCycle(
  page: Page,
  info: TestInfo,
  manualFull: boolean,
) {
  const { inspector, point } = await openPointInspector(page);
  const beforeHistory = await historyHead(page, projectPath);

  if (manualFull) {
    const grip = page.getByRole("slider", { name: "Sheet height" });
    await grip.focus();
    await page.keyboard.press("End");
    await expect(inspector).toHaveAttribute("data-detent", "full");
  }

  const initial = await viewportState(page);
  expect(initial.time).toBe("16");
  expect(initial.level).toBe("1");

  await page.setViewportSize(SHORT);
  await expect(inspector).toHaveAttribute("data-detent", "full");
  await expect(inspector.locator(".sys-actions--dock")).toHaveCount(0);
  const short = await viewportState(page);

  await page.setViewportSize(SIZES.portrait);
  await expect(inspector.locator(".sys-actions--dock")).toHaveCount(1);
  await expect(point).toHaveAttribute("data-selected");
  const returned = await viewportState(page);
  const afterHistory = await historyHead(page, projectPath);

  const name = manualFull ? "manual-full-return" : "automatic-full-return";
  const phases = {
    evidence:
      "CSS viewport resize, not physical rotation, OS zoom, hardware, or software keyboard",
    beforeHistory,
    afterHistory,
    selectedPoint: {
      id: await point.getAttribute("data-hit-id"),
      selected: await point.getAttribute("data-selected"),
    },
    initial,
    short,
    returned,
  };
  json(info, name, phases);
  await info.attach(name, {
    body: JSON.stringify(phases, null, 2),
    contentType: "application/json",
  });

  expect(afterHistory).toBe(beforeHistory);
  expect(short.viewport).toEqual(SHORT);
  expect(returned.viewport).toEqual(SIZES.portrait);
  expect(returned.time).toBe(initial.time);
  expect(returned.level).toBe(initial.level);
  await expect(inspector).toHaveAttribute(
    "data-detent",
    manualFull ? "full" : "half",
  );
}

test("automatic Full returns to Half after a short phone returns to portrait", async ({
  page,
}, info) => {
  await exerciseViewportCycle(page, info, false);
});

test("manual Full remains Full after a short phone returns to portrait", async ({
  page,
}, info) => {
  await exerciseViewportCycle(page, info, true);
});
