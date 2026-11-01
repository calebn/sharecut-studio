import { expect, type Locator, type Page, test } from "@playwright/test";
import { waiveRefineGate } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { expectPreviewFooterTouchBounds } from "./inspectorFooterBounds";
import { exposeControl } from "./inspectorResponsiveEvidence";
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

const verbBar = (page: Page) =>
  page.getByRole("group", { name: /^(Selection|Edit) actions$/ });

async function clickApproveUntilError(root: Locator): Promise<void> {
  const error = root.locator(".modifier-error");
  const approve = verbBar(root.page()).getByRole("button", {
    name: "Cut",
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
  for (const entrypoint of [
    "desktop action card",
    "phone inspector",
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
        if (entrypoint === "phone inspector") {
          await page.setViewportSize({ width: 390, height: 844 });
          await phone.showTimeline(page);
          const sheet = page.locator(".bottom-sheet--inspector");
          await expect(sheet).toBeVisible();
          for (let step = 0; step < 2; step++) {
            const expand = sheet.getByRole("button", {
              name: /^Expand(?: to (?:half|full) height)?$/,
              exact: true,
            });
            if (!(await expand.count())) break;
            await expand.click();
          }
        }
        const verb = action === "Approve" ? "Cut" : "Keep";
        const verbButton = verbBar(page).getByRole("button", {
          name: verb,
          exact: true,
        });
        if (entrypoint === "phone inspector")
          await exposeControl(page, verbButton, []);
        await verbButton.click();
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

  test("error, Ask, and A/B do not overlap at 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await stubApproveEditsRefineGate(page);
    await openSuggestedPendingEdit(page, e2eProjectPath);
    const inspector = page
      .locator(".modifier-inspector")
      .filter({ has: page.getByRole("heading", { name: "Pending edit" }) });
    await verbBar(page)
      .getByRole("button", { name: "Cut", exact: true })
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

  test("tablet card keeps error above the A/B footer", async ({ page }) => {
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
    await clickApproveUntilError(inspector);
    await expectErrorPinnedAboveAudition(inspector);
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
    await expect(page.locator(".stage-frame--phone")).toBeVisible();
    expect(
      await page.evaluate(() => matchMedia("(pointer: fine)").matches),
    ).toBe(true);
    await phone.showTimeline(page);
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
    await expectPreviewFooterTouchBounds(inspector);
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

    await expect(
      page.getByRole("region", { name: /^Needs attention/ }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 480 });
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
