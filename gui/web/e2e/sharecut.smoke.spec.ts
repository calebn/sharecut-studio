import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { hostOfflineQueueCount } from "./offlineQueue";
import { interceptCommentCommands, postHostComment } from "./queuedComment";
import { openPanel, openProject } from "./stageNav";

test.describe("ShareCut Studio smoke", () => {
  test("loads fixture project shell and is axe-clean on chrome", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);

    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await expect(
      page.getByRole("button", { name: "Play", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Script" })).toBeVisible();
    await openPanel(page, "comments");
    await expect(
      page.getByRole("region", { name: "Review queue" }),
    ).toBeVisible();
    await expect(
      page.getByRole("tablist", { name: "Review sections" }),
    ).toHaveCount(0);
    await expect(page.locator(".stage-frame")).toBeVisible();

    await expectPageAxeClean(page);
  });
  test("shows a queued host comment without a false submission error", async ({
    page,
  }) => {
    const { commands, setOffline } = await interceptCommentCommands(page);
    await openProject(page, e2eProjectPath);
    await postHostComment(page, "Queued review note");
    await expect.poll(() => commands.length).toBe(1);
    await expect
      .poll(() => hostOfflineQueueCount(page, e2eProjectPath))
      .toBe(1);
    await expect(
      page.getByRole("region", {
        name: /^Needs attention\. 1 pending(?:,|$)/,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("AddComment did not return a comment"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Comment", exact: true }),
    ).toHaveCount(0);

    setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[1]).toMatchObject({
      command_id: commands[0]?.command_id,
      client_id: commands[0]?.client_id,
      client_seq: commands[0]?.client_seq,
      type: "AddComment",
    });
    await expect(
      page.getByRole("region", { name: /^Needs attention/ }),
    ).toHaveCount(0);
  });
});
