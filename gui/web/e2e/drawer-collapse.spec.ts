import { expect, type Page, test } from "@playwright/test";
import { openDialogFromMenu, openHostProject } from "./overlayReachability";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "iPad Pro 11 landscape", width: 1194, height: 834 },
] as const;

const drawerHeight = (page: Page) =>
  page
    .locator(".bottom-tabs")
    .evaluate((el) => el.getBoundingClientRect().height);

async function dragSplitterDown(page: Page, distance: number) {
  const box = (await page
    .getByRole("separator", { name: "Resize editor panels" })
    .boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + distance, { steps: 8 });
  return () => page.mouse.up();
}

for (const { name, width, height } of VIEWPORTS) {
  test(`dragging the drawer past its minimum collapses it to the rail and the handle reopens it at ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await openHostProject(page);
    const separator = page.getByRole("separator", {
      name: "Resize editor panels",
    });
    const before = await drawerHeight(page);
    const mainBefore = (await page.locator("main").boundingBox())!.height;

    const release = await dragSplitterDown(page, before);
    await expect(separator).toHaveAttribute("data-collapse-armed", "");
    await release();

    await expect(page.locator("html")).toHaveAttribute(
      "data-layout",
      "timeline",
    );
    await expect(page.locator(".bottom-tabs")).toBeHidden();
    const mainAfter = (await page.locator("main").boundingBox())!.height;
    expect(mainAfter).toBeGreaterThan(mainBefore);
    const handle = page.getByRole("button", { name: "Show editor panels" });
    await expect(handle).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Restore layout" }),
    ).toBeVisible();

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(
      "data-layout",
      "timeline",
    );
    await handle.click();
    await expect(page.locator("html")).not.toHaveAttribute("data-layout", /.+/);
    await expect.poll(() => drawerHeight(page)).toBeCloseTo(before, 0);
    await expect(handle).toBeHidden();
  });

  test(`End collapses and a swipe up on the handle reopens at ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await openHostProject(page);
    const before = await drawerHeight(page);
    await page.getByRole("separator", { name: "Resize editor panels" }).focus();
    await page.keyboard.press("End");
    await expect(page.locator("html")).toHaveAttribute(
      "data-layout",
      "timeline",
    );

    const box = (await page
      .getByRole("button", { name: "Show editor panels" })
      .boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 24, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator("html")).not.toHaveAttribute("data-layout", /.+/);
    await expect.poll(() => drawerHeight(page)).toBeCloseTo(before, 0);
  });
}

test("the reopen handle never covers the tool rail's Undo and Redo on a phone held sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await openHostProject(page);
  await page.getByRole("button", { name: "Maximize timeline" }).click();
  await expect(
    page.getByRole("button", { name: "Show editor panels" }),
  ).toBeVisible();
  const rail = page.getByRole("group", { name: "Undo and redo" });
  for (const name of ["Undo", "Redo"]) {
    const button = rail.getByRole("button", { name });
    const covered = await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      return top !== el && !el.contains(top);
    });
    expect(covered, name).toBe(false);
  }
});

for (const collapse of ["control", "shortcut", "splitter"] as const) {
  test(`Find and replace reveals Transcript after ${collapse} collapse and reload`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHostProject(page);
    const before = await drawerHeight(page);
    if (collapse === "control") {
      await page.getByRole("button", { name: "Maximize timeline" }).click();
    } else if (collapse === "shortcut") {
      await page.keyboard.press("ControlOrMeta+2");
    } else {
      const release = await dragSplitterDown(page, before);
      await release();
    }
    await expect(page.locator("html")).toHaveAttribute(
      "data-layout",
      "timeline",
    );
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("sharecut.tabsCollapsed")),
      )
      .toBe("1");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(
      "data-layout",
      "timeline",
    );

    const openFindReplace = async () => {
      await openDialogFromMenu(page, "Commands and shortcuts");
      const palette = page.getByRole("dialog", {
        name: "Commands and shortcuts",
      });
      await palette.getByRole("combobox").fill("Find and replace");
      await palette
        .getByRole("option", { name: /Find and replace transcript/ })
        .click();
    };
    await openFindReplace();
    const form = page.getByRole("region", {
      name: "Find and replace transcript",
    });
    await expect(form).toBeVisible();
    const find = form.getByRole("textbox", { name: "Find", exact: true });
    await find.fill("delighted");
    await expect(find).toBeFocused();
    await expect(page.locator("html")).not.toHaveAttribute("data-layout", /.+/);
    await expect.poll(() => drawerHeight(page)).toBeCloseTo(before, 0);
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("sharecut.tabsCollapsed")),
      )
      .toBeNull();
    await openFindReplace();
    await expect(form).toBeHidden();
    await openFindReplace();
    await expect(form).toBeVisible();

    await page.reload();
    await expect(page.locator(".bottom-tabs")).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-layout", /.+/);
    await expect.poll(() => drawerHeight(page)).toBeCloseTo(before, 0);
  });
}
