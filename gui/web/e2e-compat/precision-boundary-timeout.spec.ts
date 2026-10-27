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
import { openProject } from "../e2e/stageNav";
import { type BrowserName, ownsStudioAxe } from "../e2e/studioAxeOwnership";
import { setTheme } from "../e2e/theme";
import { DOCUMENT_COMMAND_TIMEOUT_MS } from "../src/api/documentTransport";

const CLIENT_ID = "e2e-precision-boundary-timeout";
const TOUCH_TARGET_PX = 44;
const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
} as const;

async function proveHungLoad(
  page: Page,
  browserName: BrowserName,
  testInfo: TestInfo,
  name: keyof typeof VIEWPORTS,
  failure: "timeout" | "network" | "stale" = "timeout",
): Promise<void> {
  test.setTimeout(180_000);
  const viewport = VIEWPORTS[name];
  assertDisposableE2eProject(e2eProjectPath);
  const shots =
    process.env.BOUNDARY_TIMEOUT_SCREENSHOT_DIR ??
    testInfo.outputPath("boundary-timeout");
  fs.mkdirSync(shots, { recursive: true });
  await page.setViewportSize(viewport);
  await openProject(page, e2eProjectPath);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );
  let applied = 0;
  try {
    await waiveRefineGate(page, "e2e precision boundary timeout");
    await postDocumentCommand(page, CLIENT_ID, "CutRange", {
      mode: "ripple",
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
      else if (failure === "network") void route.abort("failed");
      else if (failure === "stale")
        void route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ detail: "The boundary changed. Reload it." }),
        });
    });
    await page.clock.install();
    await mark.click();
    const dialog = page.getByRole("dialog", { name: "Adjust boundary" });
    if (failure === "timeout") {
      await expect(dialog.getByRole("status")).toHaveText(
        "Preparing boundary controls…",
      );
      await page.clock.fastForward(DOCUMENT_COMMAND_TIMEOUT_MS);
    }
    await expect(dialog.getByRole("alert")).toHaveText(
      failure === "timeout"
        ? "The server didn't answer. Try again."
        : failure === "network"
          ? "The boundary couldn't load. Check your connection and try again."
          : "The boundary changed. Reload it.",
    );
    const action = failure === "stale" ? "Reload boundary" : "Try again";
    const tryAgain = dialog.getByRole("button", { name: action });
    await expect(tryAgain).toBeVisible();
    if (name === "phone") {
      const box = await tryAgain.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
      expect(box?.height).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
    }
    const themes =
      name === "desktop" ? (["light", "dark"] as const) : (["dark"] as const);
    for (const theme of themes) {
      await setTheme(page, theme);
      if (ownsStudioAxe({ suite: "compat", engine: browserName })) {
        await expectPageAxeClean(page);
      }
      await page.screenshot({
        path: `${shots}/${browserName}-${name}-${failure}-${theme}.png`,
      });
    }

    await tryAgain.focus();
    await tryAgain.click();
    await expect(dialog.getByRole("alert")).toBeHidden();
    await expect(dialog.getByRole("status")).toHaveText(
      "Preparing boundary controls…",
    );
    await expect(dialog.getByRole("status")).toBeFocused();
    answerRetry();
    await expect(dialog.getByRole("spinbutton")).toBeFocused();
    expect(loads).toBe(2);
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      if (ownsStudioAxe({ suite: "compat", engine: browserName })) {
        await expectPageAxeClean(page);
      }
      await page.screenshot({
        path: `${shots}/${browserName}-${name}-${failure}-${theme}-recovered.png`,
      });
    }
  } finally {
    for (let index = 0; index < applied; index += 1) {
      await postHistoryMove(page, CLIENT_ID, "UndoHistory");
    }
  }
}

test.describe("on a touch phone", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("phone: a boundary load the server never answers says to try again and recovers on Try again", async ({
    page,
    browserName,
  }, testInfo) => {
    await proveHungLoad(page, browserName, testInfo, "phone");
  });
});

test("desktop: a boundary load the server never answers says to try again and recovers on Try again", async ({
  page,
  browserName,
}, testInfo) => {
  await proveHungLoad(page, browserName, testInfo, "desktop");
});

test("desktop: network boundary load keeps focus through recovery", async ({
  page,
  browserName,
}, testInfo) => {
  await proveHungLoad(page, browserName, testInfo, "desktop", "network");
});

test("desktop: stale boundary load keeps focus through recovery", async ({
  page,
  browserName,
}, testInfo) => {
  await proveHungLoad(page, browserName, testInfo, "desktop", "stale");
});
