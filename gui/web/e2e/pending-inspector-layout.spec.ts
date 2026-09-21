import { expect, type Locator, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

const REFINE_GATE =
  "Transcript refine is required before focus/tighten/NL edits. Run podcast-transcript-refine (whole-episode pass), then `podcast transcript refine-waive --reason ...` / transcript_refine_waive_tool.";

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return !(
    a.y + a.height <= b.y + 0.5 ||
    b.y + b.height <= a.y + 0.5 ||
    a.x + a.width <= b.x + 0.5 ||
    b.x + b.width <= a.x + 0.5
  );
}

async function expectNoOverlap(a: Locator, b: Locator): Promise<void> {
  await expect(async () => {
    const boxA = await a.boundingBox({ timeout: 2_000 });
    const boxB = await b.boundingBox({ timeout: 2_000 });
    expect(boxA).toBeTruthy();
    expect(boxB).toBeTruthy();
    expect(boxesOverlap(boxA!, boxB!)).toBe(false);
  }).toPass({ timeout: 5_000, intervals: [100, 250, 500, 1_000] });
}

async function stubApproveEditsRefineGate(page: Page): Promise<void> {
  await page.route("**/api/document/command**", async (route) => {
    const body = route.request().postDataJSON() as { type?: string } | null;
    if (body?.type === "ApproveEdits") {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ detail: REFINE_GATE }),
      });
      return;
    }
    await route.continue();
  });
}

async function openPendingInspector(page: Page) {
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );
  await page.getByRole("button", { name: "Suggest cut" }).click();
  const panels = page.getByLabel("Editor panels");
  await panels.getByRole("button", { name: "Impact" }).click();
  await panels
    .getByRole("button", { name: /guest:suggest/ })
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "Pending edit" }),
  ).toBeVisible();
}

async function clickApproveUntilError(
  page: Page,
  root: Locator,
): Promise<void> {
  const error = root.locator(".modifier-error");
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(async () => {
    if (!(await error.isVisible())) {
      await approve.click();
    }
    await expect(error).toBeVisible();
  }).toPass();
}

async function expectErrorPinnedAboveAudition(root: Locator): Promise<void> {
  const error = root.locator(".modifier-error");
  const seek = root.getByRole("button", { name: "Seek" });
  const preview = root.getByRole("group", { name: "Preview mode" });
  await expect(error).toBeVisible();
  await expect(
    root.getByRole("region", { name: "Ask about this edit" }),
  ).toBeAttached();
  await expectNoOverlap(error, seek);
  await expectNoOverlap(error, preview);
}

test.describe("Pending inspector layout", () => {
  test("error, Ask, and A/B do not overlap at 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await stubApproveEditsRefineGate(page);
    await openPendingInspector(page);
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    const error = page.locator(".modifier-error");
    const askHelp = page.getByText(/Hear Suggested, then approve/);
    const name = page.getByText("Your name");
    const seek = page.getByRole("button", { name: "Seek" });
    const preview = page.getByRole("group", { name: "Preview mode" });
    await expect(error).toBeVisible();
    await expectNoOverlap(error, askHelp);
    await expectNoOverlap(error, seek);
    await expectNoOverlap(error, preview);
    await expectNoOverlap(seek, name);
    await expectNoOverlap(name, preview);
  });

  test("tablet sheet keeps error above the A/B footer", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await stubApproveEditsRefineGate(page);
    await openPendingInspector(page);
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator(".daw-shell--tablet")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Pending edit" }),
    ).toBeVisible();
    const dialog = page.getByRole("dialog", { name: "Inspector" });
    await clickApproveUntilError(page, dialog);
    await expectErrorPinnedAboveAudition(dialog);
    const seekBox = await dialog
      .getByRole("button", { name: "Seek" })
      .boundingBox();
    const previewBox = await dialog
      .getByRole("group", { name: "Preview mode" })
      .boundingBox();
    const sheetBox = await dialog.boundingBox();
    expect(seekBox).toBeTruthy();
    expect(previewBox).toBeTruthy();
    expect(sheetBox).toBeTruthy();
    expect(seekBox!.y + seekBox!.height).toBeLessThanOrEqual(
      sheetBox!.y + sheetBox!.height + 0.5,
    );
    expect(previewBox!.y + previewBox!.height).toBeLessThanOrEqual(
      sheetBox!.y + sheetBox!.height + 0.5,
    );
  });

  test("phone sheet keeps error above the A/B footer", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await stubApproveEditsRefineGate(page);
    await openPendingInspector(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".daw-shell--phone")).toBeVisible();
    await page.getByRole("button", { name: "Timeline" }).click();
    const dialog = page.getByRole("dialog", { name: "Inspector" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Pending edit" }),
    ).toBeVisible();
    await clickApproveUntilError(page, dialog);
    await expectErrorPinnedAboveAudition(dialog);
    const seekBox = await dialog
      .getByRole("button", { name: "Seek" })
      .boundingBox();
    const previewBox = await dialog
      .getByRole("group", { name: "Preview mode" })
      .boundingBox();
    const sheetBox = await dialog.boundingBox();
    expect(seekBox).toBeTruthy();
    expect(previewBox).toBeTruthy();
    expect(sheetBox).toBeTruthy();
    expect(seekBox!.y + seekBox!.height).toBeLessThanOrEqual(
      sheetBox!.y + sheetBox!.height + 0.5,
    );
    expect(previewBox!.y + previewBox!.height).toBeLessThanOrEqual(
      sheetBox!.y + sheetBox!.height + 0.5,
    );
  });
});
