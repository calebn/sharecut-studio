import { expect, type Page, test } from "@playwright/test";
import { openHostProject } from "../e2e/overlayReachability";

const drawerHeight = (page: Page) =>
  page
    .locator(".bottom-tabs")
    .evaluate((el) => el.getBoundingClientRect().height);

async function dragSplitter(page: Page, dy: number) {
  const box = (await page
    .getByRole("separator", { name: "Resize editor panels" })
    .boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 8 });
  await page.mouse.up();
}

test("the drawer handle drags up and back down repeatedly", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHostProject(page);
  for (let i = 0; i < 3; i++) {
    const before = await drawerHeight(page);
    await dragSplitter(page, -60);
    await expect.poll(() => drawerHeight(page)).toBeGreaterThan(before + 20);
    const taller = await drawerHeight(page);
    await dragSplitter(page, 40);
    await expect.poll(() => drawerHeight(page)).toBeLessThan(taller - 20);
  }
});

test("the handle's hit area stays below the timeline's scrollbar and keeps its grip visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHostProject(page);
  const separator = page.getByRole("separator", {
    name: "Resize editor panels",
  });
  const geometry = await separator.evaluate((el) => {
    const panel = el.parentElement!.getBoundingClientRect();
    const grip = el.querySelector(".bottom-tabs-splitter-grip")!;
    const gripBox = grip.getBoundingClientRect();
    const x = gripBox.x + gripBox.width / 2;
    const above = document.elementFromPoint(x, panel.top - 2);
    const onGrip = document.elementFromPoint(x, gripBox.y + gripBox.height / 2);
    return {
      aboveIsSplitter: !!above && el.contains(above),
      gripHit: !!onGrip && el.contains(onGrip),
      gripTop: gripBox.top,
      panelTop: panel.top,
    };
  });
  expect(geometry.aboveIsSplitter).toBe(false);
  expect(geometry.gripHit).toBe(true);
  expect(geometry.gripTop).toBeGreaterThanOrEqual(geometry.panelTop);
});

async function doubleClickSplitter(page: Page) {
  const box = (await page
    .getByRole("separator", { name: "Resize editor panels" })
    .boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height - 3);
}

test("double-clicking the drawer handle collapses it and the rail handle reopens it at the same height", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHostProject(page);
  await dragSplitter(page, -40);
  await expect.poll(() => drawerHeight(page)).toBeGreaterThan(220);
  const before = await drawerHeight(page);
  await page.waitForTimeout(700);
  await doubleClickSplitter(page);
  await expect(page.locator("html")).toHaveAttribute("data-layout", "timeline");
  await expect(page.locator(".bottom-tabs")).toBeHidden();
  await page.getByRole("button", { name: "Show editor panels" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-layout", /.+/);
  await expect.poll(() => drawerHeight(page)).toBeCloseTo(before, 0);
});

test("a quick double-click on the rail handle reopens the drawer and leaves it open", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHostProject(page);
  await page.waitForTimeout(700);
  await doubleClickSplitter(page);
  const handle = page.getByRole("button", { name: "Show editor panels" });
  await expect(handle).toBeVisible();
  const box = (await handle.boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height - 4);
  await expect(page.locator("html")).not.toHaveAttribute("data-layout", /.+/);
  await page.waitForTimeout(800);
  await expect(page.locator(".bottom-tabs")).toBeVisible();
});
