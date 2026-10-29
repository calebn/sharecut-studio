import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { createRelocatedE2eProject } from "./liveProject";
import { withShareableProject } from "./shareableProject";
import { openPanel, openProject } from "./stageNav";

const INSIDE_CUT = 1;
const OUTSIDE_CUT = 20;

function unsureProject(prefix: string) {
  const copy = createRelocatedE2eProject(prefix);
  const data = JSON.parse(fs.readFileSync(copy.projectPath, "utf8"));
  data.editorial.edit_decisions = [
    {
      id: "a",
      proposal_origin: "programmatic",
      boundary_intent: "programmatic",
      track_id: "reference",
      type: "remove",
      applied: false,
      review_required: true,
      start: 2,
      end: 3,
      reason: "guest:suggest",
    },
  ];
  data.editorial.edit_log = [];
  const track = data.transcripts.per_track.find(
    (t: { track_id: string }) => t.track_id === "reference",
  );
  for (const index of [INSIDE_CUT, OUTSIDE_CUT])
    track.words[index].confidence = 0.4;
  fs.writeFileSync(copy.projectPath, `${JSON.stringify(data, null, 2)}\n`);
  return copy;
}

const toast = (page: Page) => page.locator(".ui-toast-region--app");
const words = (page: Page) =>
  page.getByRole("region", { name: "Unsure words" }).locator(".sys-queue-main");

async function openQueue(page: Page, projectPath: string) {
  await openProject(page, projectPath, { stage: "review" });
  await openPanel(page, "queue");
  await expect(page.locator(".rv-stage")).toBeVisible();
}

test("unsure words: Looks right, Undo, Fix text, and the last word closes the check", async ({
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await openQueue(page, projectPath);
      const stage = page.locator(".rv-stage");
      await expect(words(page)).toHaveCount(2);
      await expect(
        page.getByText("Check the transcript", { exact: true }),
      ).toBeVisible();

      await words(page).filter({ hasText: "uncle" }).click();
      await stage.getByRole("button", { name: "Looks right" }).click();
      await expect(toast(page).getByText("Looks right")).toBeVisible();
      await toast(page).getByRole("button", { name: /undo/i }).click();
      await expect(words(page)).toHaveCount(2);
      await expect(stage).toBeFocused();

      await words(page).filter({ hasText: "uncle" }).click();
      await stage.getByRole("button", { name: "Fix text" }).click();
      await stage
        .getByRole("textbox", { name: /^Corrected text for/ })
        .fill("Uncle");
      await stage.getByRole("button", { name: "Save" }).click();
      await expect(toast(page).getByText(/^Fixed/)).toBeVisible();

      await words(page).filter({ hasText: "hamlet" }).click();
      await stage.getByRole("button", { name: "Looks right" }).click();
      await expect(
        page.getByText("Check the transcript", { exact: true }),
      ).toHaveCount(0);
    },
    undefined,
    unsureProject,
  );
});
