import { expect, type Locator, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { exposeControl } from "./inspectorResponsiveEvidence";
import { openSuggestedPendingEdit } from "./pendingEdit";

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
        status: 409,
        contentType: "application/json",
        headers: { "X-Sharecut-Error-Code": "transcript_refine_required" },
        body: JSON.stringify({ detail: REFINE_GATE }),
      });
      return;
    }
    await route.continue();
  });
}

async function clickApproveUntilError(root: Locator): Promise<void> {
  const error = root.locator(".modifier-error");
  const approve = root.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeVisible();
  await expect
    .poll(async () =>
      approve.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return (
          document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          ) === button
        );
      }),
    )
    .toBe(true);
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
    await openSuggestedPendingEdit(page, e2eProjectPath);
    const inspector = page
      .locator(".modifier-inspector")
      .filter({ has: page.getByRole("heading", { name: "Pending edit" }) });
    await inspector
      .getByRole("button", { name: "Approve", exact: true })
      .click();
    const error = inspector.locator(".modifier-error");
    const askHelp = inspector.getByText(/Hear Suggested, then approve/);
    const name = inspector.getByText("Your name");
    const seek = inspector.getByRole("button", { name: "Seek" });
    const preview = inspector.getByRole("group", { name: "Preview mode" });
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
    await openSuggestedPendingEdit(page, e2eProjectPath);
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator(".daw-shell--tablet")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Pending edit" }),
    ).toBeVisible();
    const dialog = page.getByRole("dialog", { name: "Inspector" });
    await clickApproveUntilError(dialog);
    await expectErrorPinnedAboveAudition(dialog);
    await exposeControl(page, dialog.getByRole("button", { name: "Seek" }), []);
    await exposeControl(
      page,
      dialog.getByRole("group", { name: "Preview mode" }),
      [],
    );
  });

  test("phone sheet keeps error above the A/B footer", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await stubApproveEditsRefineGate(page);
    await openSuggestedPendingEdit(page, e2eProjectPath);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".daw-shell--phone")).toBeVisible();
    await page.getByRole("button", { name: "Timeline" }).click();
    // The phone timeline opens the compact drawer; at full height it holds
    // the whole pending inspector.
    const dialog = page.locator(".bottom-sheet--compact");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Expand to half height" }).click();
    await dialog.getByRole("button", { name: "Expand to full height" }).click();
    await expect(
      dialog.getByRole("heading", { name: "Pending edit" }),
    ).toBeVisible();
    const inspector = dialog.getByRole("complementary");
    await clickApproveUntilError(inspector);
    await expectErrorPinnedAboveAudition(inspector);
    await exposeControl(
      page,
      inspector.getByRole("button", { name: "Seek" }),
      [],
    );
    await exposeControl(
      page,
      inspector.getByRole("group", { name: "Preview mode" }),
      [],
    );
  });

  test("inline review stays hit-testable and tall recovery scrolls outside the lane", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await stubApproveEditsRefineGate(page);
    await openSuggestedPendingEdit(page, e2eProjectPath);

    const actionbar = page.getByRole("region", {
      name: "Pending edit actions",
    });
    const approve = actionbar.getByRole("button", {
      name: "Approve",
      exact: true,
    });
    await expect(approve).toBeVisible();
    await expect
      .poll(async () =>
        approve.evaluate((button) => {
          const rect = button.getBoundingClientRect();
          return (
            document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            ) === button
          );
        }),
      )
      .toBe(true);
    await approve.click();
    const recovery = actionbar.getByRole("region", {
      name: "Transcript refine recovery",
    });
    await expect(actionbar.getByRole("alert")).toBeVisible();
    await expect(
      recovery.getByRole("button", { name: "Waive with reason" }),
    ).toBeAttached();

    await page.setViewportSize({ width: 1280, height: 360 });
    await expect
      .poll(() =>
        actionbar.evaluate((panel) => panel.scrollHeight > panel.clientHeight),
      )
      .toBe(true);
    const [panelBox, regionBox, viewport] = await Promise.all([
      actionbar.boundingBox(),
      page.locator(".pending-overlay.selected").boundingBox(),
      page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    ]);
    expect(panelBox).toBeTruthy();
    expect(regionBox).toBeTruthy();
    expect(panelBox!.x).toBeGreaterThanOrEqual(8);
    expect(panelBox!.y).toBeGreaterThanOrEqual(8);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(
      viewport.width - 8,
    );
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(
      viewport.height - 8,
    );
    expect(
      panelBox!.y + panelBox!.height <= regionBox!.y - 7 ||
        panelBox!.y >= regionBox!.y + regionBox!.height + 7,
    ).toBe(true);

    await actionbar.evaluate((panel) => {
      panel.scrollTop = panel.scrollHeight;
    });
    await expect(
      recovery.getByRole("button", { name: "Waive with reason" }),
    ).toBeInViewport();
  });
});
