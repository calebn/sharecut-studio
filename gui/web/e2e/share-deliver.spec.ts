import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { createRecordRoom } from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { createReviewShare } from "./shareNavigation";
import { openProject, openShare } from "./stageNav";

test.describe("Share on Deliver", () => {
  test("sits in the Deliver page on phones with Create review link in reach", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      const share = await openShare(page);
      expect(await page.getByRole("dialog").count()).toBe(0);
      const create = share.getByRole("button", { name: "Create review link" });
      await create.scrollIntoViewIfNeeded();
      await expect(create).toBeInViewport();
      await expectPageAxeClean(page, ".dv-stage");
    });
  });

  test("sits beside the episode file on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      const share = await openShare(page);
      const episode = page.getByRole("region", { name: "Episode file" });
      const shareBox = await share.boundingBox();
      const episodeBox = await episode.boundingBox();
      expect(shareBox!.x).toBeGreaterThan(
        episodeBox!.x + episodeBox!.width - 1,
      );
      expect(shareBox!.width).toBeLessThan(600);
    });
  });

  test("confirms Stop sharing and End room in place, naming the consequence", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      await createReviewShare(page, projectPath, "viewer");
      const room = await createRecordRoom(page, projectPath);
      const nativeDialogs: string[] = [];
      page.on("dialog", (native) => {
        nativeDialogs.push(native.message());
        void native.dismiss();
      });
      const share = await openShare(page);

      const stop = share.getByRole("button", { name: "Stop sharing" });
      await stop.click();
      const confirm = share.getByRole("group", {
        name: "Stop sharing this Viewer link? Anyone using it loses access.",
      });
      await expect(confirm).toBeVisible();
      await expect(
        confirm.getByRole("button", { name: "Keep link" }),
      ).toBeFocused();
      await expectPageAxeClean(page, ".dv-stage");
      await confirm.getByRole("button", { name: "Keep link" }).click();
      await expect(confirm).toBeHidden();
      await expect(stop).toBeFocused();

      await stop.click();
      await confirm.getByRole("button", { name: "Stop sharing" }).click();
      await expect(share.getByText("No review links yet.")).toBeVisible();
      await expect(share.locator(".dv-share-feedback")).toHaveText(
        "Stopped sharing the Viewer link",
      );

      await share.getByRole("button", { name: "End room" }).click();
      const endConfirm = share.getByRole("group", {
        name: "End this record room? Both guest and producer links will stop working.",
      });
      await endConfirm.getByRole("button", { name: "End room" }).click();
      await expect(share.getByText("No record rooms yet.")).toBeVisible();
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

  test("The header Invite goes to Deliver and focuses Create review link", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      await page.getByRole("button", { name: "Invite" }).click();
      const share = page
        .getByRole("region", { name: "Deliver" })
        .getByRole("region", { name: "Share", exact: true });
      await expect(share).toBeVisible();
      await expect(
        share.getByRole("button", { name: "Create review link" }),
      ).toBeFocused();
    });
  });
});
