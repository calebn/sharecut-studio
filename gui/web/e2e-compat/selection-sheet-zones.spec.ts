import { expect, test } from "@playwright/test";
import { openHostProject } from "../e2e/overlayReachability";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { inspectSelection } from "../e2e/stageNav";

test.use({ hasTouch: true, actionTimeout: 15_000 });

test("the phone sheet shows its rows and leaves its commands to the dock", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHostProject(page);
  await openPhoneTimeline(page);
  await page.locator(".clip-hit").first().tap();
  await inspectSelection(page);
  const sheet = page.locator(".sys-inspector--phone");
  await expect(
    sheet.getByRole("spinbutton", { name: "Source start", exact: true }),
  ).toBeVisible();
  await expect(sheet.locator(".sys-actions--dock")).toBeVisible();
});

test("the tablet clip sheet shows its rows and leaves its commands to the Action bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await openHostProject(page);
  await page.locator(".clip-hit").first().tap();
  await inspectSelection(page);
  const sheet = page.getByRole("dialog", { name: "Inspector" });
  await expect(
    sheet.getByRole("spinbutton", { name: "Source start", exact: true }),
  ).toBeVisible();
});
