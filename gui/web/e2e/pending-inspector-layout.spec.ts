import { expect, type Locator, type Page, test } from "@playwright/test";
import { decideOnBar, selectionBar } from "./actionBar";
import { waiveRefineGate } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { openSuggestedPendingEdit } from "./pendingEdit";
import { phone } from "./stageNav";

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

async function clickApproveUntilError(
  page: Page,
  errorRoot: Locator,
): Promise<void> {
  const error = errorRoot.locator(".modifier-error");
  await expect(async () => {
    if (!(await error.isVisible())) await decideOnBar(page, "Approve");
    await expect(error).toBeVisible();
  }).toPass();
}

/** The preview footer is gone where the Action bar plays and seeks; the error sits above Ask. */
async function expectErrorAboveAskWithNoFooter(root: Locator): Promise<void> {
  const error = root.locator(".modifier-error");
  await expect(error).toBeVisible();
  await expect(
    root.getByRole("region", { name: "Ask about this edit" }),
  ).toBeAttached();
  await expect(root.getByRole("group", { name: "Preview mode" })).toHaveCount(
    0,
  );
  await expect(root.locator(".modifier-footer")).toHaveCount(0);
}

test.describe("Pending inspector layout", () => {
  for (const entrypoint of [
    "desktop Action bar",
    "phone inspector dock",
  ] as const) {
    test(`${entrypoint} reports a single review and Undo restores its pending edit`, async ({
      page,
    }) => {
      for (const action of ["Approve", "Reject"] as const) {
        await page.setViewportSize({ width: 1280, height: 720 });
        await openSuggestedPendingEdit(page, e2eProjectPath);
        if (action === "Approve") {
          await waiveRefineGate(page, "Single pending-review feedback fixture");
        }
        const editId = await page
          .locator(".pending-overlay.selected")
          .getAttribute("data-pending-id");
        expect(editId).not.toBeNull();
        if (entrypoint === "phone inspector dock") {
          await page.setViewportSize({ width: 390, height: 844 });
          await phone.showTimeline(page);
          await expect(page.locator(".sys-inspector--phone")).toBeVisible();
        }
        await decideOnBar(page, action);
        const feedback = page.getByRole("region", { name: "Status messages" });
        await expect(feedback).toContainText(
          action === "Approve"
            ? "Approved 1 pending edit"
            : "Rejected 1 pending edit",
        );
        const undo = feedback.getByRole("button", {
          name: "Undo",
          exact: true,
        });
        await expect(undo).toBeVisible();
        await undo.click();
        await expect
          .poll(async () => {
            const response = await page.request.get(
              `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=shell`,
            );
            const project = (await response.json()) as {
              pending_edits: { id: string }[];
            };
            return project.pending_edits.some((edit) => edit.id === editId);
          })
          .toBe(true);
      }
    });
  }

  test("error and Ask do not overlap at 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await stubApproveEditsRefineGate(page);
    await openSuggestedPendingEdit(page, e2eProjectPath);
    const inspector = page
      .locator(".modifier-inspector")
      .filter({ has: page.getByRole("heading", { name: "Pending edit" }) });
    await decideOnBar(page, "Approve");
    const error = inspector.locator(".modifier-error");
    const askHelp = inspector.getByText(
      /Ask a question here before you approve/,
    );
    const name = inspector.getByText("Your name");
    await expect(error).toBeVisible();
    await expectNoOverlap(error, askHelp);
    await expectNoOverlap(error, name);
    await expect(
      inspector.getByRole("group", { name: "Preview mode" }),
    ).toHaveCount(0);
  });

  test("tablet card keeps error above Ask and has no preview footer", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await stubApproveEditsRefineGate(page);
    await openSuggestedPendingEdit(page, e2eProjectPath);
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator(".stage-frame--tablet")).toBeVisible();
    // The tablet opens the Inspector card, which holds the whole pending inspector.
    const dialog = page.getByRole("dialog", { name: "Inspector", exact: true });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Pending edit" }),
    ).toBeVisible();
    const inspector = dialog.getByRole("complementary");
    await clickApproveUntilError(page, inspector);
    await expectErrorAboveAskWithNoFooter(inspector);
  });

  test("phone sheet keeps error above Ask and has no preview footer", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await stubApproveEditsRefineGate(page);
    await openSuggestedPendingEdit(page, e2eProjectPath);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".stage-frame--phone")).toBeVisible();
    expect(
      await page.evaluate(() => matchMedia("(pointer: fine)").matches),
    ).toBe(true);
    await phone.showTimeline(page);
    // The phone timeline opens the Inspector sheet; at full height it holds
    // the whole pending inspector.
    const dialog = page.locator(".sys-inspector--phone");
    await expect(dialog).toBeVisible();
    await page.getByRole("slider", { name: "Sheet height" }).press("End");
    await expect(
      dialog.getByRole("heading", { name: "Pending edit" }),
    ).toBeVisible();
    const inspector = dialog.getByRole("complementary");
    await clickApproveUntilError(page, inspector);
    // The sheet's dock carries Seek and Preview, so the preview footer is gone.
    await expectErrorAboveAskWithNoFooter(inspector);
  });

  test("a refused Approve on the bar leaves the recovery reachable in the Inspector", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await stubApproveEditsRefineGate(page);
    await openSuggestedPendingEdit(page, e2eProjectPath);
    await expect(selectionBar(page)).toHaveCount(1);
    await expect(selectionBar(page)).toBeVisible();
    await decideOnBar(page, "Approve");
    const inspector = page
      .locator(".modifier-inspector")
      .filter({ has: page.getByRole("heading", { name: "Pending edit" }) });
    const recovery = inspector.getByRole("region", {
      name: "Transcript refine recovery",
    });
    await expect(inspector.getByRole("alert")).toBeVisible();
    await expect(
      recovery.getByRole("button", { name: "Cut anyway" }),
    ).toBeInViewport();
    await expect(
      page.getByRole("group", { name: /^Needs attention/ }),
    ).toHaveCount(0);
  });
});
