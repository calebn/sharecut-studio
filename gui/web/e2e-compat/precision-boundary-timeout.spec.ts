import fs from "node:fs";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { expectPageAxeClean } from "../e2e/axe";
import {
  boundaryContainingRestoredWord,
  openTranscript,
} from "../e2e/boundaryFixture";
import {
  postDocumentCommand,
  postHistoryMove,
  waiveRefineGate,
} from "../e2e/documentCommand";
import { assertDisposableE2eProject, e2eProjectPath } from "../e2e/env";
import { setTheme } from "../e2e/theme";
import { DOCUMENT_COMMAND_TIMEOUT_MS } from "../src/api/documentTransport";

const CLIENT_ID = "e2e-precision-boundary-timeout";
const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
} as const;

async function proveHungLoad(
  page: Page,
  browserName: string,
  testInfo: TestInfo,
  name: keyof typeof VIEWPORTS,
): Promise<void> {
  test.setTimeout(180_000);
  const viewport = VIEWPORTS[name];
  assertDisposableE2eProject(e2eProjectPath);
  const shots =
    process.env.BOUNDARY_TIMEOUT_SCREENSHOT_DIR ??
    testInfo.outputPath("boundary-timeout");
  fs.mkdirSync(shots, { recursive: true });
  await page.setViewportSize(viewport);
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );
  let applied = 0;
  try {
    await waiveRefineGate(page, "e2e precision boundary timeout");
    await postDocumentCommand(page, CLIENT_ID, "CutRange", {
      mode: "ripple",
      confirm_cut_speech: true,
      start: 5,
      end: 15,
    });
    applied += 1;
    const boundary = await boundaryContainingRestoredWord(page);
    await openTranscript(page);
    const mark = page.locator(
      `.edit-boundary-mark[data-boundary-id="${boundary.id}"]`,
    );
    await expect(mark).toBeVisible();
    await mark.scrollIntoViewIfNeeded();

    let loads = 0;
    let answerRetry = () => {};
    const retryMayAnswer = new Promise<void>((resolve) => {
      answerRetry = resolve;
    });
    await page.route("**/api/boundary/context*", (route) => {
      loads += 1;
      if (loads > 1) void retryMayAnswer.then(() => route.continue());
    });
    await page.clock.install();
    await mark.click();
    const dialog = page.getByRole("dialog", { name: "Adjust boundary" });
    await expect(dialog.getByRole("status")).toHaveText(
      "Preparing boundary controls…",
    );
    await page.clock.fastForward(DOCUMENT_COMMAND_TIMEOUT_MS);
    await expect(dialog.getByRole("alert")).toHaveText(
      "The server didn't answer. Try again.",
    );
    await expect(
      dialog.getByRole("button", { name: "Reload boundary" }),
    ).toBeHidden();
    const tryAgain = dialog.getByRole("button", { name: "Try again" });
    await expect(tryAgain).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      await expectPageAxeClean(page);
      await page.screenshot({
        path: `${shots}/${browserName}-${name}-${theme}.png`,
      });
    }

    await tryAgain.click();
    await expect(dialog.getByRole("alert")).toBeHidden();
    await expect(dialog.getByRole("status")).toHaveText(
      "Preparing boundary controls…",
    );
    answerRetry();
    await expect(dialog.getByRole("spinbutton")).toBeVisible();
    expect(loads).toBe(2);
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      await expectPageAxeClean(page);
      await page.screenshot({
        path: `${shots}/${browserName}-${name}-${theme}-recovered.png`,
      });
    }
  } finally {
    for (let index = 0; index < applied; index += 1) {
      await postHistoryMove(page, CLIENT_ID, "UndoHistory");
    }
  }
}

test("phone: a boundary load the server never answers says to try again and recovers on Try again", async ({
  page,
  browserName,
}, testInfo) => {
  await proveHungLoad(page, browserName, testInfo, "phone");
});

test("desktop: a boundary load the server never answers says to try again and recovers on Try again", async ({
  page,
  browserName,
}, testInfo) => {
  await proveHungLoad(page, browserName, testInfo, "desktop");
});
