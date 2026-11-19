import { expect, test } from "@playwright/test";
import type { ProjectView } from "../src/types/project";
import { createScriptRecordingIdentityProject } from "./scriptRecordingIdentityProject";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";
import { openScript } from "./transcriptEdit";

const profile = process.env.SCRIPT_RECORDING_IDENTITY_PROFILE;
if (profile !== "parent" && profile !== "head")
  throw new Error("A fixed paired verification profile is required");

test.use({ trace: "off", screenshot: "off", video: "off" });

test("Script and Find show the expected recording identities for the fixed pair", async ({
  browser,
  page,
}) => {
  expect(browser.browserType().name()).toBe("chromium");
  expect(browser.version()).toBe("158.0.8127.18");
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
      const cutSource = profile === "parent" ? "primary" : null;
      expect(boundary?.cutaway_word_ids).toEqual([
        {
          track_id: "host",
          source_id: cutSource,
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
      const words = body.locator(".sys-script-word");
      for (const text of [/^alpha$/, /^omega$/, /^beta$/, /^delta$/])
        await expect(words.filter({ hasText: text })).toBeVisible();
      const echoes = words.filter({ hasText: /^echo$/ });
      await expect(echoes).toHaveCount(profile === "parent" ? 1 : 2);
      const cut = body.locator(
        `.sys-script-word[data-word-key="host:${cutSource ?? ""}:-2"]`,
      );
      const other = body.locator(
        '.sys-script-word[data-word-key="host:other:1"]',
      );
      await expect(cut).toBeVisible();
      await expect(cut).toHaveText("echo");
      await expect(cut).toHaveAttribute("data-state", "cut");

      if (profile === "parent") {
        await expect(other).toHaveCount(0);
      } else {
        await expect(other).toBeVisible();
        await expect(other).toHaveText("echo");
        await expect(other).not.toHaveAttribute("data-state", "cut");
      }

      await page.getByRole("button", { name: "Find in transcript" }).click();
      const bar = page.getByRole("search", { name: "Find in transcript" });
      const field = bar.getByRole("searchbox", { name: "Find", exact: true });
      await field.fill("echo");
      await expect(bar).toContainText(
        profile === "parent" ? "No matches" : "1 of 1",
      );
      await expect(cut).not.toHaveAttribute("data-found");
      if (profile === "head") await expect(other).toHaveAttribute("data-found");

      if (profile === "head") {
        await field.fill("alpha omega");
        await expect(bar).toContainText("No matches");
      }
      await field.fill("omega beta");
      await expect(bar).toContainText("No matches");
      await field.fill("beta echo");
      await expect(bar).toContainText(
        profile === "parent" ? "No matches" : "1 of 1",
      );

      await field.fill("delta");
      await expect(bar).toContainText("1 of 1");
      await expect(words.filter({ hasText: /^delta$/ })).toHaveAttribute(
        "data-found",
      );
    },
    undefined,
    createScriptRecordingIdentityProject,
  );
});
