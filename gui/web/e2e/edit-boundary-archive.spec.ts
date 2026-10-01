import { expect, test } from "@playwright/test";
import type { ProjectView } from "../src/types/project";
import { postDocumentCommand, waiveRefineGate } from "./documentCommand";
import { assertDisposableE2eProject, e2eProjectPath } from "./env";

const CLIENT_ID = "e2e-edit-boundary-archive";

test("rolling a cut boundary restores an archived transcript word through history", async ({
  page,
}) => {
  assertDisposableE2eProject(e2eProjectPath);
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );

  let applied = 0;
  try {
    await waiveRefineGate(page, "e2e edit boundary archive");
    await postDocumentCommand(page, CLIENT_ID, "RippleDeleteRange", {
      start: 5,
      end: 15,
    });
    applied += 1;

    const afterCutResponse = await page.request.get(
      `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
    );
    expect(afterCutResponse.ok()).toBe(true);
    const afterCut = (await afterCutResponse.json()) as ProjectView;
    const boundary = afterCut.edit_boundaries?.find((candidate) =>
      candidate.cutaway_word_ids.some(
        (word) =>
          word.text.toLowerCase() === "so" &&
          word.start === 5 &&
          word.end === 6,
      ),
    );
    expect(boundary, "the cutaway includes the reference word so").toBeTruthy();
    const archivedSo = boundary!.cutaway_word_ids.find(
      (word) => word.text.toLowerCase() === "so",
    );
    expect(archivedSo?.word_index).toBeLessThan(0);

    const panels = page.getByLabel("Editor panels");
    await panels
      .getByRole("button", { name: "Transcript", exact: true })
      .click();
    const annotate = panels.locator(".transcript-annotate-btn");
    await expect(annotate).toBeVisible();
    if ((await annotate.getAttribute("aria-pressed")) !== "true") {
      await annotate.click();
    }
    await expect(annotate).toHaveAttribute("aria-pressed", "true");

    const mark = page.locator(
      `.edit-boundary-mark[data-boundary-id="${boundary!.id}"]`,
    );
    await expect(mark).toBeVisible();
    await mark.scrollIntoViewIfNeeded();
    const box = await mark.boundingBox();
    expect(box).toBeTruthy();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    const rolls: Array<{ delta_sec?: number }> = [];
    page.on("request", (request) => {
      if (
        !request.url().includes("/api/document/command") ||
        request.method() !== "POST"
      ) {
        return;
      }
      const command = request.postDataJSON() as {
        type?: string;
        payload?: { delta_sec?: number };
      };
      if (command.type === "RollClipJoin") rolls.push(command.payload ?? {});
    });
    await page.mouse.move(x, y);
    await page.mouse.down();
    const rollResponse = page.waitForResponse((response) => {
      if (
        !response.url().includes("/api/document/command") ||
        response.request().method() !== "POST"
      ) {
        return false;
      }
      const command = response.request().postDataJSON() as { type?: string };
      return command.type === "RollClipJoin";
    });
    await page.mouse.move(x + 120, y);
    const preview = page.getByRole("group", { name: "Preview restored words" });
    await expect(preview).toContainText("so");
    await page.mouse.up();
    const roll = await rollResponse;
    expect(roll.ok()).toBe(true);
    applied += 1;
    expect(rolls).toHaveLength(1);
    expect(rolls[0]?.delta_sec).toBeCloseTo(1.5, 1);

    await page.reload();
    const rolledResponse = await page.request.get(
      `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
    );
    expect(rolledResponse.ok()).toBe(true);
    const rolled = (await rolledResponse.json()) as ProjectView;
    const activeSo = rolled.transcript?.utterances
      .flatMap((utterance) => utterance.words ?? [])
      .find((word) => word.text.toLowerCase() === "so" && word.mappable);
    expect(activeSo, "so is restored as an active mappable word").toBeTruthy();
    await page
      .getByLabel("Editor panels")
      .getByRole("button", { name: "Transcript", exact: true })
      .click();
    await expect(
      page
        .locator("[data-transcript-word]")
        .filter({ hasText: /^so$/ })
        .first(),
    ).toBeVisible();

    await postDocumentCommand(page, CLIENT_ID, "UndoHistory", {
      rerender: false,
    });
    applied -= 1;
    await page.reload();
    const undoneResponse = await page.request.get(
      `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
    );
    expect(undoneResponse.ok()).toBe(true);
    const undone = (await undoneResponse.json()) as ProjectView;
    const undoneSo = undone.transcript?.utterances
      .flatMap((utterance) => utterance.words ?? [])
      .find((word) => word.text.toLowerCase() === "so" && word.mappable);
    expect(undoneSo, "undo archives so again").toBeUndefined();
    expect(
      undone.edit_boundaries?.some((candidate) =>
        candidate.cutaway_word_ids.some(
          (word) => word.text.toLowerCase() === "so" && word.word_index < 0,
        ),
      ),
      "undo restores so in the cutaway archive preview",
    ).toBe(true);

    await postDocumentCommand(page, CLIENT_ID, "RedoHistory", {
      rerender: false,
    });
    applied += 1;
    await page.reload();
    const redoneResponse = await page.request.get(
      `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
    );
    expect(redoneResponse.ok()).toBe(true);
    const redone = (await redoneResponse.json()) as ProjectView;
    const redoneSo = redone.transcript?.utterances
      .flatMap((utterance) => utterance.words ?? [])
      .find((word) => word.text.toLowerCase() === "so" && word.mappable);
    expect(
      redoneSo,
      "redo restores so as an active mappable word",
    ).toBeTruthy();
  } finally {
    for (let index = 0; index < applied; index += 1) {
      await postDocumentCommand(page, CLIENT_ID, "UndoHistory", {
        rerender: false,
      });
    }
  }
});
