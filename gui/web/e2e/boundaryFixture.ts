import { expect, type Page } from "@playwright/test";
import type { ProjectView } from "../src/types/project";
import { e2eProjectPath } from "./env";
import { openPanel } from "./stageNav";

export async function openTranscript(page: Page): Promise<void> {
  await openPanel(page, "transcript");
  const annotate = page.locator(".transcript-annotate-btn");
  await expect(annotate).toBeVisible();
  if ((await annotate.getAttribute("aria-pressed")) !== "true") {
    await annotate.click();
  }
  await expect(annotate).toHaveAttribute("aria-pressed", "true");
}

export async function boundaryContainingRestoredWord(page: Page) {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
  );
  expect(response.ok()).toBe(true);
  const project = (await response.json()) as ProjectView;
  const boundary = project.edit_boundaries?.find((candidate) =>
    candidate.cutaway_word_ids.some(
      (word) =>
        word.text.toLowerCase() === "dissatisfied" &&
        word.start === 5.37 &&
        word.end === 6.23,
    ),
  );
  if (!boundary) {
    throw new Error(
      "The boundary does not contain the archived word dissatisfied",
    );
  }
  return boundary;
}
