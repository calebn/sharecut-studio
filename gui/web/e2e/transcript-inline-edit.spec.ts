import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { postDocumentCommand, postHistoryMove } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { expectNoHorizontalScroll } from "./modelsMock";
import { withShareableProject } from "./shareableProject";
import { openProject, phone } from "./stageNav";
import { openScript, withDocumentCommandTypes } from "./transcriptEdit";

test.describe("Script Fix text", () => {
  test("F2 on a focused word opens Fix text and Escape gives the word back its focus", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    const list = await openScript(page);
    const word = list.getByRole("button", { name: /^my(?: \(.*\))?$/ }).first();
    await word.focus();
    await page.keyboard.press("F2");
    const input = list.getByRole("textbox", { name: "Fix text" });
    await expect(input).toBeFocused();
    await expectPageAxeClean(page, ".sys-script");
    await input.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(word).toBeFocused();
  });
  test("F2, type, Enter commits one undoable step; Mod+Z restores", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        /aligned dialogue/i,
      );
      const list = await openScript(page);
      const original = list
        .getByRole("button", { name: /^my(?: \(.*\))?$/ })
        .first();
      let committed = false;
      try {
        await withDocumentCommandTypes(page, async (commands) => {
          const input = list.getByRole("textbox", { name: "Fix text" });
          await original.dblclick();
          await expect(input).toHaveCount(0);
          await original.focus();
          await page.keyboard.press("F2");
          await expect(input).toBeFocused();
          await input.press("Escape");
          await expect(input).toHaveCount(0);
          expect(commands).not.toContain("CorrectTranscriptWord");

          await original.focus();
          await page.keyboard.press("F2");
          await expect(input).toBeFocused();
          await expectPageAxeClean(page, ".sys-script");
          await input.fill("My");
          await input.press("Enter");
          await expect(
            list.getByRole("button", { name: /^My(?: \(.*\))?$/ }).first(),
          ).toBeVisible();
          committed = true;
          expect(commands).toContain("CorrectTranscriptWord");

          await page.keyboard.press("ControlOrMeta+Z");
          await expect(
            list.getByRole("button", { name: /^my(?: \(.*\))?$/ }).first(),
          ).toBeVisible();
          await expect(
            list.getByRole("button", { name: /^My(?: \(.*\))?$/ }),
          ).toHaveCount(0);
          committed = false;
        });
      } finally {
        if (committed) {
          await postHistoryMove(
            page,
            "e2e-inline-edit",
            "UndoHistory",
            projectPath,
          );
        }
      }
    });
  });
});

async function doubleTapFirstMy(page: Page) {
  const list = page.locator(".sys-script-body");
  const word = list.getByRole("button", { name: /^my(?: \(.*\))?$/ }).first();
  await word.scrollIntoViewIfNeeded();
  const point = await word.boundingBox();
  expect(point).not.toBeNull();
  const x = point!.x + point!.width / 2;
  const y = point!.y + point!.height / 2;
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);
  const field = list.getByRole("textbox", { name: "Fix text" });
  await expect(field).toBeFocused();
  return { list, field };
}

test.describe("Phone Fix text", () => {
  test.use({
    viewport: { width: 320, height: 568 },
    hasTouch: true,
    reducedMotion: "reduce",
  });

  for (const cell of [
    { name: "small portrait", width: 320, height: 568 },
    { name: "portrait", width: 390, height: 844 },
    { name: "landscape", width: 844, height: 390 },
  ]) {
    test.describe(cell.name, () => {
      test.use({ viewport: { width: cell.width, height: cell.height } });

      test(`Fix text fits the ${cell.name} Script, uncovered and without overflow`, async ({
        page,
      }) => {
        await withShareableProject(async (projectPath) => {
          await openProject(page, projectPath);
          await phone.showText(page);
          const { field } = await doubleTapFirstMy(page);
          await field.fill("a considerably longer correction ".repeat(6));

          const fit = await page.evaluate(() => {
            const input = document.querySelector<HTMLElement>(
              ".sys-script-body [aria-label='Fix text']",
            )!;
            const body =
              document.querySelector<HTMLElement>(".sys-script-body")!;
            const box = input.getBoundingClientRect();
            const pane = body.getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
            return {
              box,
              pane,
              scrollWidth: body.scrollWidth,
              clientWidth: body.clientWidth,
              width: window.innerWidth,
              height: window.innerHeight,
              hitsField: hit === input || input.contains(hit),
            };
          });
          expect(fit.box.left).toBeGreaterThanOrEqual(fit.pane.left - 1);
          expect(fit.box.right).toBeLessThanOrEqual(fit.pane.right + 1);
          expect(fit.box.top).toBeGreaterThanOrEqual(fit.pane.top - 1);
          expect(fit.box.bottom).toBeLessThanOrEqual(fit.pane.bottom + 1);
          expect(fit.box.left).toBeGreaterThanOrEqual(-1);
          expect(fit.box.right).toBeLessThanOrEqual(fit.width + 1);
          expect(fit.box.top).toBeGreaterThanOrEqual(-1);
          expect(fit.box.bottom).toBeLessThanOrEqual(fit.height + 1);
          expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
          expect(fit.hitsField).toBe(true);
          await expectNoHorizontalScroll(page);
          await expectPageAxeClean(page, ".sys-script");
          await field.press("Escape");
          await expect(field).toHaveCount(0);
        });
      });
    });
  }

  test("a double tap opens Fix text in the Script and a fix commits there", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      await phone.showText(page);
      const { list, field } = await doubleTapFirstMy(page);
      await expect(field).toBeInViewport({ ratio: 0.9 });
      await expectPageAxeClean(page, ".sys-script");

      let savedHead: string | null = null;
      let failed = false;
      let failure: unknown;
      try {
        await field.fill("My");
        const saving = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().includes("/api/document/command") &&
            response.request().postDataJSON()?.type === "CorrectTranscriptWord",
        );
        await field.press("Enter");
        const reply = await saving;
        expect(reply.ok()).toBe(true);
        const result = (await reply.json()) as { history_head_id?: string };
        savedHead = result.history_head_id ?? null;
        expect(savedHead).not.toBeNull();
        await expect(
          list.getByRole("button", { name: /^My(?: \(.*\))?$/ }).first(),
        ).toBeVisible();
      } catch (error) {
        failed = true;
        failure = error;
      }
      if (savedHead) {
        try {
          await postDocumentCommand(
            page,
            "e2e-phone-correct-cleanup",
            "UndoHistory",
            {
              rerender: false,
              expected_head_id: savedHead,
            },
            projectPath,
          );
        } catch (error) {
          if (failed) {
            test.info().annotations.push({
              type: "Correction cleanup failure",
              description: String(error),
            });
          } else {
            failed = true;
            failure = error;
          }
        }
      }
      if (failed) throw failure;
    });
  });
});
