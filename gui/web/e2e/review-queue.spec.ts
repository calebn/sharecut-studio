import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { createRelocatedE2eProject } from "./liveProject";
import { withShareableProject } from "./shareableProject";
import { openPanel, openProject } from "./stageNav";

const DECISION = {
  proposal_origin: "programmatic",
  boundary_intent: "programmatic",
  track_id: "reference",
  type: "remove",
  applied: false,
  review_required: true,
};

function queueProject(prefix: string) {
  const copy = createRelocatedE2eProject(prefix);
  const data = JSON.parse(fs.readFileSync(copy.projectPath, "utf8"));
  data.editorial.edit_decisions = [
    { ...DECISION, id: "a", start: 2, end: 3, reason: "guest:suggest" },
    { ...DECISION, id: "b", start: 6, end: 7, reason: "guest:suggest" },
    {
      ...DECISION,
      id: "laugh",
      start: 10,
      end: 11,
      reason: "filler:acoustic:likely_laugh",
    },
  ];
  data.editorial.edit_log = [];
  fs.writeFileSync(copy.projectPath, `${JSON.stringify(data, null, 2)}\n`);
  return copy;
}

async function openQueue(page: Page, projectPath: string) {
  await openProject(page, projectPath, { stage: "review" });
  await openPanel(page, "queue");
  await expect(page.locator(".rv-stage")).toBeVisible();
}

const selectedRow = (page: Page) =>
  page.locator('.sys-queue-main[aria-current="true"]');

test("Keep, then Undo from the toast returns the row selected with focus on the stage", async ({
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await openQueue(page, projectPath);
      await page.locator(".sys-queue-main", { hasText: "0:02" }).click();
      await expect(selectedRow(page)).toContainText("0:02");
      await page
        .locator(".rv-stage")
        .getByRole("button", { name: "Keep", exact: true })
        .click();
      const toast = page.locator(".ui-toast-region--app");
      await expect(toast.getByText("Kept", { exact: true })).toBeVisible();
      await expect(selectedRow(page)).not.toContainText("0:02");
      await toast.getByRole("button", { name: /undo/i }).click();
      await expect(selectedRow(page)).toContainText("0:02");
      await expect(page.locator(".rv-stage")).toBeFocused();
    },
    undefined,
    queueProject,
  );
});

test("Lower on a laugh writes a lowered span into the clip", async ({
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await openQueue(page, projectPath);
      await page.locator(".sys-queue-main", { hasText: "0:10" }).click();
      const stage = page.locator(".rv-stage");
      await stage.getByRole("button", { name: "Lower", exact: true }).click();
      // The fixture's transcript is not checked, so the cut waits for Cut anyway.
      await stage.getByRole("button", { name: "Lower anyway" }).click();
      await expect(
        page.locator(".ui-toast-region--app").getByText(/^Lower/),
      ).toBeVisible();
      const lowered = await page.evaluate(async (path) => {
        const res = await fetch(
          `/api/project?path=${encodeURIComponent(path)}&phase=shell`,
        );
        const project = (await res.json()) as {
          clips: {
            tracks: Record<
              string,
              { mute_regions?: { gain_db?: number | null }[] }[]
            >;
          };
        };
        return Object.values(project.clips.tracks)
          .flat()
          .flatMap((clip) => clip.mute_regions ?? [])
          .filter((region) => region.gain_db != null).length;
      }, projectPath);
      expect(lowered).toBeGreaterThan(0);
    },
    undefined,
    queueProject,
  );
});
