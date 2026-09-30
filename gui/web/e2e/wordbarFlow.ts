import fs from "node:fs";
import { expect, type Page } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import {
  openTranscriptPanel,
  withDocumentCommandTypes,
} from "./transcriptEdit";

function transcripts(): unknown {
  const stored = JSON.parse(
    fs.readFileSync(e2eProjectPath, "utf8"),
  ).transcripts;
  // Legacy fixture JSON omits null/false model defaults that any save materializes.
  return JSON.parse(
    JSON.stringify(stored, (_key, value) =>
      value === null || value === false ? undefined : value,
    ),
  );
}

export async function checkWordbarOutsideRelease(page: Page): Promise<void> {
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  const list = await openTranscriptPanel(page);
  await page.getByRole("button", { name: /^Correct:/ }).click();
  await list.locator("button[data-transcript-word]").first().click();
  await page
    .getByRole("button", { name: "Adjust timing", exact: true })
    .click();
  const end = page.getByRole("slider", { name: "Word end" });
  await expect(end).toBeEnabled();
  await expectPageAxeClean(page, ".transcript-wordbar");
  const before = transcripts();
  await withDocumentCommandTypes(page, async (commands) => {
    await end.scrollIntoViewIfNeeded();
    const box = await end.boundingBox();
    if (!box) throw new Error("Missing native word boundary");
    const min = Number(await end.getAttribute("min"));
    const max = Number(await end.getAttribute("max"));
    const value = Number(await end.inputValue());
    const x = box.x + 8 + ((box.width - 16) * (value - min)) / (max - min);
    await page.mouse.move(x, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x + 16, box.y + box.height / 2, { steps: 8 });
    expect(
      commands.filter((type) => type === "SetTranscriptWordTiming"),
    ).toHaveLength(0);
    // Native range tracking must deliver release after leaving both the control and inspector.
    await page.mouse.move((page.viewportSize()?.width ?? 1280) - 1, 30);
    await page.mouse.up();
    await expect(
      page.getByText("Timing saved. One Undo restores both boundaries."),
    ).toBeVisible();
    expect(
      commands.filter((type) => type === "SetTranscriptWordTiming"),
    ).toHaveLength(1);
    expect(transcripts()).not.toEqual(before);
    await page.getByRole("button", { name: "Undo timing" }).click();
    await expect(end).toHaveCount(0);
    await expect.poll(transcripts).toEqual(before);
  });
}
