import { expect, test } from "@playwright/test";
import type { ProjectView } from "../src/types/project";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { hostOfflineQueueCount } from "./offlineQueue";
import { interceptCommentCommands, postHostComment } from "./queuedComment";
import { createScriptRecordingIdentityProject } from "./scriptRecordingIdentityProject";
import { withShareableProject } from "./shareableProject";
import { openPanel, openProject } from "./stageNav";
import { openScript } from "./transcriptEdit";

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
      page.getByRole("region", { name: "Queue", exact: true }),
    ).toBeVisible();
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
      page.getByRole("group", {
        name: /^Needs attention\. 1 pending(?:,|$)/,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("AddComment did not return a comment"),
    ).toHaveCount(0);
    await expect(
      page
        .locator(".rv-compose")
        .getByRole("textbox", { name: "Comment", exact: true }),
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
      page.getByRole("group", { name: /^Needs attention/ }),
    ).toHaveCount(0);
  });
});

test("Script Find keeps equal-index words in separate recordings beside a primary cut preview", async ({
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openProject(page, projectPath);
      const body = await openScript(page);
      const response = await page.request.get(
        `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
      );
      expect(response.ok()).toBe(true);
      const project = (await response.json()) as ProjectView;
      const boundary = project.edit_boundaries?.find(
        (row) => row.left_clip_id === "left" && row.right_clip_id === "right",
      );
      expect(boundary?.cutaway_word_ids).toEqual([
        {
          track_id: "host",
          source_id: null,
          word_index: -2,
          text: "echo",
          start: 1.2,
          end: 1.5,
        },
      ]);
      const showCut = page.getByRole("button", {
        name: "Show cut text",
        exact: true,
      });
      if ((await showCut.getAttribute("aria-pressed")) !== "true")
        await showCut.click();
      await expect(showCut).toHaveAttribute("aria-pressed", "true");
      const echoes = body
        .locator(".sys-script-word")
        .filter({ hasText: /^echo$/ });
      await expect(echoes).toHaveCount(2);
      const cut = body.locator('.sys-script-word[data-word-key="host::-2"]');
      const other = body.locator(
        '.sys-script-word[data-word-key="host:other:1"]',
      );
      await expect(cut).toHaveText("echo");
      await expect(cut).toHaveAttribute("data-state", "cut");
      await expect(other).toHaveText("echo");
      await expect(other).not.toHaveAttribute("data-state", "cut");
      await page.getByRole("button", { name: "Find in transcript" }).click();
      const bar = page.getByRole("search", { name: "Find in transcript" });
      const field = bar.getByRole("searchbox", { name: "Find", exact: true });
      await field.fill("echo");
      await expect(bar).toContainText("1 of 1");
      await expect(other).toHaveAttribute("data-found");
      await expect(cut).not.toHaveAttribute("data-found");
      await field.fill("alpha omega");
      await expect(bar).toContainText("No matches");
      await field.fill("omega beta");
      await expect(bar).toContainText("No matches");
      await field.fill("beta echo");
      await expect(bar).toContainText("1 of 1");
    },
    undefined,
    createScriptRecordingIdentityProject,
  );
});
