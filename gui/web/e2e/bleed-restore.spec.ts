import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { createRelocatedE2eProject } from "./liveProject";
import { openPhoneTimeline, rememberInspectorDetent } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { inspectSelection, openProject } from "./stageNav";

function createBleedRestoreProject(prefix: string) {
  const relocated = createRelocatedE2eProject(prefix);
  const { projectPath } = relocated;
  const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  const selected = project.timeline.clips[0];
  selected.source_end = 8;
  selected.off_speaker_mute_regions = [
    { start_s: 4, end_s: 6, fade_out_ms: 5, fade_in_ms: 5 },
  ];
  const other = {
    ...selected,
    id: "bleed-other-occurrence",
    timeline_start: 10,
    off_speaker_mute_regions: [],
  };
  project.timeline.clips.push(other);
  fs.writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  return relocated;
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`automatic reduction Restore and exact Undo at ${viewport.width}px`, async ({
    page,
  }) => {
    await withShareableProject(
      async (projectPath) => {
        const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
        const selected = project.timeline.clips[0];
        const otherOccurrence = project.timeline.clips.find(
          (clip: { id: string }) => clip.id === "bleed-other-occurrence",
        );
        await page.setViewportSize(viewport);
        if (viewport.width === 390) await rememberInspectorDetent(page, "half");
        await openProject(page, projectPath);
        await expect(page.getByRole("heading", { level: 1 })).toContainText(
          /aligned dialogue/i,
        );
        if (viewport.width === 390) await openPhoneTimeline(page);
        await page.locator(`[data-clip-id="${selected.id}"]`).click();
        await inspectSelection(page);
        await page
          .getByRole("button", { name: "Inspect automatic audio reduction" })
          .click();
        const regions = page.getByRole("group", {
          name: "Automatic regions in this clip",
        });
        const region = regions.getByRole("button", {
          name: /^Automatic speaker mute Timeline .* Source /,
        });
        await expect(region).toBeVisible();
        const restore = page.getByRole("button", {
          name: "Restore original audio",
          exact: true,
        });
        await expect(restore).toBeDisabled();
        await region.click();
        await expect(restore).toBeEnabled();
        await page.getByRole("button", { name: "Refresh regions" }).click();
        await expect(region).toHaveAttribute("aria-pressed", "false");
        await expect(restore).toBeDisabled();
        await region.click();
        await expectPageAxeClean(page, ".inspector");
        const command = page.waitForRequest((request) => {
          if (!request.url().includes("/api/document/command")) return false;
          return request.postDataJSON()?.type === "RestoreClipBleed";
        });
        await restore.click();
        const sent = await command;
        expect(sent.postDataJSON().payload.target.clip.id).toBe(selected.id);
        expect((await sent.response())?.ok()).toBe(true);
        await expect
          .poll(() => {
            const saved = JSON.parse(fs.readFileSync(projectPath, "utf8"));
            return saved.timeline.clips.find(
              (clip: { id: string }) => clip.id === selected.id,
            ).bleed_restore?.regions;
          })
          .toEqual([{ start_s: 4, end_s: 6 }]);
        const saved = JSON.parse(fs.readFileSync(projectPath, "utf8"));
        expect(
          saved.timeline.clips.find(
            (clip: { id: string }) => clip.id === "bleed-other-occurrence",
          ),
        ).toEqual(otherOccurrence);
        const undo = page.getByRole("button", {
          name: "Undo Restore",
          exact: true,
        });
        await expect(undo).toBeEnabled();
        const undoRequest = page.waitForRequest((request) => {
          if (!request.url().includes("/api/document/command")) return false;
          return request.postDataJSON()?.type === "UndoHistory";
        });
        await undo.click();
        const undone = await undoRequest;
        expect(undone.postDataJSON().payload.expected_head_id).toBe(
          saved.history.entries[saved.history.cursor].id,
        );
        expect((await undone.response())?.ok()).toBe(true);
        await expect
          .poll(() => {
            const current = JSON.parse(fs.readFileSync(projectPath, "utf8"));
            return (
              current.timeline.clips.find(
                (clip: { id: string }) => clip.id === selected.id,
              ).bleed_restore ?? null
            );
          })
          .toBeNull();
        await expect(undo).toHaveCount(0);
      },
      undefined,
      createBleedRestoreProject,
    );
  });
}
