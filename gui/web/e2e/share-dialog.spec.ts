import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { openDialogFromMenu } from "./overlayReachability";
import { createRecordRoom } from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { createReviewShare } from "./shareNavigation";

async function openShare(page: Page, projectPath: string) {
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  await openDialogFromMenu(page, "Share…");
  const dialog = page.getByRole("dialog", { name: "Share", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Share dialog", () => {
  test("is a bottom sheet on phones with Create review link pinned", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await withShareableProject(async (projectPath) => {
      const dialog = await openShare(page, projectPath);
      const panel = dialog.locator(".command-palette-panel");
      // The sheet rises into place; wait for it to settle on the bottom edge.
      await expect
        .poll(async () => {
          const box = await panel.boundingBox();
          return box && [Math.round(box.width), Math.round(box.y + box.height)];
        })
        .toEqual([390, 844]);

      const create = dialog.getByRole("button", {
        name: "Create review link",
      });
      const footer = dialog.locator(".command-palette-footer");
      await expect(footer.getByRole("button")).toHaveText([
        "Create review link",
      ]);
      await dialog.locator(".command-palette-body").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(create).toBeInViewport();
      const createBox = await create.boundingBox();
      expect(createBox!.y + createBox!.height).toBeGreaterThan(844 - 100);
      await expectPageAxeClean(page, ".ui-dialog-root");
    });
  });

  test("stays a centered dialog on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await withShareableProject(async (projectPath) => {
      const dialog = await openShare(page, projectPath);
      const box = await dialog.locator(".command-palette-panel").boundingBox();
      expect(box!.width).toBeLessThan(600);
      expect(box!.y).toBeGreaterThan(0);
    });
  });

  test("confirms Stop sharing and End room in place, naming the consequence", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await withShareableProject(async (projectPath) => {
      await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
      await createReviewShare(page, projectPath, "viewer");
      const room = await createRecordRoom(page, projectPath);
      const nativeDialogs: string[] = [];
      page.on("dialog", (native) => {
        nativeDialogs.push(native.message());
        void native.dismiss();
      });
      const dialog = await openShare(page, projectPath);

      const stop = dialog.getByRole("button", { name: "Stop sharing" });
      await stop.click();
      const confirm = dialog.getByRole("group", {
        name: "Stop sharing this Viewer link? Anyone using it loses access.",
      });
      await expect(confirm).toBeVisible();
      await expect(
        confirm.getByRole("button", { name: "Keep link" }),
      ).toBeFocused();
      await expectPageAxeClean(page, ".ui-dialog-root");
      await confirm.getByRole("button", { name: "Keep link" }).click();
      await expect(confirm).toBeHidden();
      await expect(stop).toBeFocused();

      await stop.click();
      await confirm.getByRole("button", { name: "Stop sharing" }).click();
      await expect(dialog.getByText("No review links yet.")).toBeVisible();
      await expect(dialog.locator(".share-dialog-feedback")).toHaveText(
        "Stopped sharing the Viewer link",
      );

      await dialog.getByRole("button", { name: "End room" }).click();
      const endConfirm = dialog.getByRole("group", {
        name: "End this record room? Both guest and producer links will stop working.",
      });
      await endConfirm.getByRole("button", { name: "End room" }).click();
      await expect(dialog.getByText("No record rooms yet.")).toBeVisible();
      const rows = await page.request.get(
        `/api/shares?path=${encodeURIComponent(projectPath)}`,
      );
      const body = (await rows.json()) as {
        shares: { session_id?: string | null; usable: boolean }[];
      };
      expect(
        body.shares.filter(
          (row) => row.session_id === room.session_id && row.usable,
        ),
      ).toEqual([]);
      expect(nativeDialogs).toEqual([]);
    });
  });
});
