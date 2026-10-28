import { expect, type Locator, type TestInfo } from "@playwright/test";
import {
  type Fixtures,
  openAt,
  SIZES,
  test,
} from "../e2e/compactChromeFixture";
import { newFinger } from "../e2e/finger";
import { controlGeometry } from "../e2e/inspectorResponsiveEvidence";

import { json, watchCommands } from "../e2e/touchTimeline";

test.use({ hasTouch: true });
test.describe.configure({ timeout: 240_000 });

/** The blade confirmation's Cut is in view and on top at `rootPx`, and a tap on it cuts. */
async function cutIsTappable(
  name: keyof typeof SIZES,
  rootPx: number,
  { page, context, browserName }: Fixtures,
  info: TestInfo,
): Promise<void> {
  await openAt(page, SIZES[name]);
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, rootPx);
  await page.waitForTimeout(400);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  const tapCentre = async (target: Locator) => {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error("no box to tap");
    await finger.down({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await page.waitForTimeout(60);
    await finger.up();
  };
  // A window 16rem tall or less folds the tool strip behind the header's Tools
  // button, and the Blade cut button sits in that sheet with the tools; taller
  // ones show the strip.
  const tools = page.getByRole("button", { name: "Tools", exact: true });
  const strip = page.getByRole("group", { name: "Editing tools" });
  await expect(tools.or(strip)).toBeVisible();
  const folded = await tools.isVisible();
  if (folded) await tapCentre(tools);
  await tapCentre(
    page.getByRole("button", { name: "Blade tool", exact: true }).first(),
  );
  const cutAtPlayhead = page.getByRole("button", { name: /^Blade cut/ });
  if (folded && !(await cutAtPlayhead.isVisible())) await tapCentre(tools);
  await expect(cutAtPlayhead).toBeVisible();
  await tapCentre(cutAtPlayhead);
  const dialog = page.getByRole("dialog", { name: /^Cut at / });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(600);
  const cut = dialog.getByRole("button", { name: "Cut", exact: true });
  const state = await controlGeometry(cut);
  json(info, `chrome-blade-${name}-${rootPx}-${browserName}`, state);
  expect(state).toMatchObject({ fullyVisible: true, hitsControl: true });
  await tapCentre(cut);
  await expect(dialog).toHaveCount(0);
  // The split runs after the confirm resolves, so the command can land after the dialog closes.
  await expect.poll(() => commands.map((c) => c.type)).toContain("SplitAtTime");
}

test("the Cut button of the blade confirmation can be tapped at 16px text: portrait", ({
  page,
  context,
  browserName,
}, info) =>
  cutIsTappable("portrait", 16, { page, context, browserName }, info));

test("the Cut button of the blade confirmation can be tapped at 32px text: portrait", ({
  page,
  context,
  browserName,
}, info) =>
  cutIsTappable("portrait", 32, { page, context, browserName }, info));

test("the Cut button of the blade confirmation can be tapped at 16px text: landscape", ({
  page,
  context,
  browserName,
}, info) =>
  cutIsTappable("landscape", 16, { page, context, browserName }, info));

test("the Cut button of the blade confirmation can be tapped at 32px text: landscape", ({
  page,
  context,
  browserName,
}, info) =>
  cutIsTappable("landscape", 32, { page, context, browserName }, info));
