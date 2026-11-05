import fs from "node:fs";
import { expect, type Page } from "@playwright/test";
import { isApplePlatform } from "../src/utils/platform";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { inspectSelectionByKey, openProject } from "./stageNav";
import { openScript, withDocumentCommandTypes } from "./transcriptEdit";

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
  await openProject(page, e2eProjectPath);
  const list = await openScript(page);
  await list.locator(".sys-script-word").first().click();
  await inspectSelectionByKey(page);
  const end = page.getByRole("spinbutton", { name: "Word end" });
  await expect(end).toBeEnabled();
  await expectPageAxeClean(page, ".transcript-wordbar");
  const before = transcripts();
  await withDocumentCommandTypes(page, async (commands) => {
    const handle = page.locator('[data-boundary="end"] .wordbar-handle');
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    if (!box) throw new Error("Missing word boundary handle");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 16, y, { steps: 8 });
    expect(
      commands.filter((type) => type === "SetTranscriptWordTiming"),
    ).toHaveLength(0);
    // Pointer capture must deliver release after leaving both the handle and the inspector.
    await page.mouse.move((page.viewportSize()?.width ?? 1280) - 1, 30);
    await page.mouse.up();
    await expect(
      page.getByText("Timing saved. One Undo restores both boundaries."),
    ).toBeVisible();
    expect(
      commands.filter((type) => type === "SetTranscriptWordTiming"),
    ).toHaveLength(1);
    expect(transcripts()).not.toEqual(before);
    await page.keyboard.press(
      (await page.evaluate(isApplePlatform)) ? "Meta+z" : "Control+z",
    );
    await expect.poll(transcripts).toEqual(before);
  });
}
