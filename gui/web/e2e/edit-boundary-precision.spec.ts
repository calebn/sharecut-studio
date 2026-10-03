import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import type { ProjectView } from "../src/types/project";
import { expectPageAxeClean } from "./axe";
import { postDocumentCommand, waiveRefineGate } from "./documentCommand";
import { assertDisposableE2eProject, e2eProjectPath } from "./env";
import { setTheme } from "./theme";

const CLIENT_ID = "e2e-edit-boundary-precision";

type DocumentCommand = {
  type?: string;
  payload?: Record<string, unknown>;
};

declare global {
  interface Window {
    __boundaryMediaEvents?: Array<{ type: string; source: string }>;
  }
}

async function openTranscript(page: Page): Promise<void> {
  const phoneNavigation = page.getByRole("navigation", { name: "Primary" });
  if (
    (await page.locator(".daw-shell").getAttribute("data-shell")) === "phone"
  ) {
    await phoneNavigation
      .getByRole("button", { name: "Text", exact: true })
      .click();
  } else {
    await page
      .getByLabel("Editor panels")
      .getByRole("button", {
        name: "Transcript",
        exact: true,
      })
      .click();
  }
  const annotate = page.locator(".transcript-annotate-btn");
  await expect(annotate).toBeVisible();
  if ((await annotate.getAttribute("aria-pressed")) !== "true") {
    await annotate.click();
  }
  await expect(annotate).toHaveAttribute("aria-pressed", "true");
}

async function boundaryContainingRestoredWord(page: Page) {
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

test("precision boundary editing previews, cancels, and restores transcript audio safely", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const artifactDir =
    process.env.BOUNDARY_PRECISION_SCREENSHOT_DIR ??
    testInfo.outputPath("boundary-precision");
  assertDisposableE2eProject(e2eProjectPath);
  await page.addInitScript(() => {
    const originalPlay = HTMLMediaElement.prototype.play;
    const originalPause = HTMLMediaElement.prototype.pause;
    const events: Array<{ type: string; source: string }> = [];
    Object.defineProperty(window, "__boundaryMediaEvents", {
      configurable: false,
      value: events,
    });
    HTMLMediaElement.prototype.play = function () {
      events.push({ type: "play", source: this.currentSrc || this.src });
      return originalPlay.call(this);
    };
    HTMLMediaElement.prototype.pause = function () {
      events.push({ type: "pause", source: this.currentSrc || this.src });
      return originalPause.call(this);
    };
  });

  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );
  let applied = 0;
  const commands: DocumentCommand[] = [];
  const audioRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/api/document/command") &&
      request.method() === "POST"
    ) {
      commands.push(request.postDataJSON() as DocumentCommand);
    }
    if (
      request.url().includes("/api/boundary/audition/") &&
      request.method() === "GET"
    ) {
      audioRequests.push(request.url());
    }
  });

  try {
    await waiveRefineGate(page, "e2e precision boundary");
    await postDocumentCommand(page, CLIENT_ID, "RippleDeleteRange", {
      start: 5,
      end: 15,
    });
    applied += 1;
    commands.length = 0;

    const boundary = await boundaryContainingRestoredWord(page);
    await openTranscript(page);
    const mark = page.locator(
      `.edit-boundary-mark[data-boundary-id="${boundary.id}"]`,
    );
    await expect(mark).toBeVisible();
    await mark.scrollIntoViewIfNeeded();

    let forceStale = true;
    await page.route("**/api/boundary/context*", async (route) => {
      if (forceStale && route.request().method() === "POST") {
        forceStale = false;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Boundary geometry changed" }),
        });
        return;
      }
      await route.continue();
    });

    await mark.click();
    let dialog = page.getByRole("dialog", { name: "Adjust boundary" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText(/changed|stale|409/i);
    await dialog.getByRole("button", { name: "Reload boundary" }).click();
    await expect(dialog.getByRole("spinbutton")).toBeVisible();
    await page.unroute("**/api/boundary/context*");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(mark).toBeFocused();
    await expect.poll(() => commands.length).toBe(0);

    await page.keyboard.press("Enter");
    dialog = page.getByRole("dialog", { name: "Adjust boundary" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(dialog).toBeHidden();
    await expect(mark).toBeFocused();
    await expect.poll(() => commands.length).toBe(0);

    await page.keyboard.press("Space");
    dialog = page.getByRole("dialog", { name: "Adjust boundary" });
    await expect(dialog).toBeVisible();
    const offset = dialog.getByRole("spinbutton", {
      name: "Change join by (seconds)",
    });
    await expect(offset).toHaveValue("0");

    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => commands.length).toBe(0);

    await mark.click();
    dialog = page.getByRole("dialog", { name: "Adjust boundary" });
    await expect(dialog).toBeVisible();
    const signedOffset = dialog.getByRole("spinbutton", {
      name: "Change join by (seconds)",
    });
    await signedOffset.click();
    await page.keyboard.press("Control+A");
    for (const key of ["-", "0", ".", "0", "1", "0"]) {
      await page.keyboard.press(key);
    }
    await expect
      .poll(async () => Number(await signedOffset.inputValue()))
      .toBeCloseTo(-0.01, 3);
    await expect(
      dialog.getByText("Proposed source position").locator(".."),
    ).toContainText(/\d+\.\d{3} s/);
    await dialog
      .getByRole("button", { name: "Adjust by plus 1 millisecond" })
      .click();
    await expect(signedOffset).toHaveValue("-0.009");
    await dialog
      .getByRole("button", { name: "Adjust by plus 10 milliseconds" })
      .click();
    await expect(signedOffset).toHaveValue("0.001");
    await signedOffset.fill("999");
    await expect(dialog.getByRole("button", { name: "Apply" })).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Listen current" }),
    ).toBeDisabled();
    await expect(dialog.getByRole("alert")).toContainText(
      "Enter a whole-millisecond offset from",
    );
    await signedOffset.fill("0.0005");
    await expect(signedOffset).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByRole("button", { name: "Apply" })).toBeDisabled();
    await expect(dialog.getByRole("alert")).toContainText(
      "Enter a whole-millisecond offset from",
    );
    await signedOffset.fill("1.000");
    const ghostStatus = dialog
      .getByRole("status")
      .filter({ hasText: "word spans" });
    await expect(ghostStatus).toContainText("dissatisfied");
    await expect(ghostStatus).toContainText("touched in part");
    await signedOffset.fill("1.500");
    await expect(ghostStatus).toContainText("2 word spans fully restored");
    await expect(ghostStatus).toContainText("dissatisfied");

    const currentResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/boundary/audition") &&
        response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Listen current" }).click();
    const currentResult = await currentResponse;
    expect(currentResult.ok()).toBe(true);
    const audition = (await currentResult.json()) as {
      token: string;
      actual_edit: { delta_sec?: number };
      current: { url: string };
      proposed: { url: string };
    };
    expect(audition.token).toBeTruthy();
    expect(audition.actual_edit.delta_sec).toBeCloseTo(1.5, 3);
    expect(audition.current.url).not.toEqual(audition.proposed.url);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__boundaryMediaEvents?.some(
              (event) => event.type === "play",
            ) ?? false,
        ),
      )
      .toBe(true);
    await expect.poll(() => audioRequests.length).toBeGreaterThanOrEqual(1);

    const pausesBeforeClear = await page.evaluate(
      () =>
        window.__boundaryMediaEvents?.filter((event) => event.type === "pause")
          .length ?? 0,
    );
    await signedOffset.fill("");
    await expect(signedOffset).toHaveAttribute("aria-invalid", "true");
    await expect(
      dialog.getByRole("button", { name: "Listen current" }),
    ).toBeDisabled();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__boundaryMediaEvents?.filter(
              (event) => event.type === "pause",
            ).length ?? 0,
        ),
      )
      .toBeGreaterThan(pausesBeforeClear);
    await signedOffset.fill("1.500");
    const retryAuditionResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/boundary/audition") &&
        response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Listen proposed" }).click();
    const retryAudition = await retryAuditionResponse;
    expect(retryAudition.ok()).toBe(true);
    expect(
      ((await retryAudition.json()) as typeof audition).token,
    ).toBeTruthy();
    await expect.poll(() => audioRequests.length).toBeGreaterThanOrEqual(2);

    await dialog.getByRole("button", { name: "Listen current" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__boundaryMediaEvents?.filter(
              (event) => event.type === "play",
            ).length ?? 0,
        ),
      )
      .toBeGreaterThanOrEqual(3);
    await expect.poll(() => audioRequests.length).toBeGreaterThanOrEqual(3);
    expect(audioRequests[0]).toContain("/current?");
    expect(audioRequests[1]).toContain("/proposed?");
    expect(audioRequests[2]).toContain("/current?");

    if (process.env.BOUNDARY_PRECISION_SKIP_SCREENSHOTS !== "1") {
      fs.mkdirSync(artifactDir, { recursive: true });
      const screenshots = [
        { name: "desktop-light", width: 1440, theme: "light" as const },
        { name: "desktop-dark", width: 1440, theme: "dark" as const },
        { name: "phone-light", width: 360, theme: "light" as const },
        { name: "phone-dark", width: 360, theme: "dark" as const },
      ];
      for (const shot of screenshots) {
        await page.setViewportSize({ width: shot.width, height: 900 });
        await setTheme(page, shot.theme);
        if (shot.width < 720) {
          const textTab = page.getByRole("button", {
            name: "Text",
            exact: true,
          });
          await expect(textTab).toBeVisible();
          if ((await textTab.getAttribute("aria-pressed")) !== "true") {
            await textTab.click();
          }
          await expect(mark).toBeVisible();
          if (await dialog.isHidden()) {
            await mark.click();
            dialog = page.getByRole("dialog", { name: "Adjust boundary" });
            await expect(dialog).toBeVisible();
            await dialog
              .getByRole("spinbutton", { name: "Change join by (seconds)" })
              .fill("1.500");
          }
        }
        await expect(dialog).toBeVisible();
        await expectPageAxeClean(page, ".precision-boundary-dialog");
        await page.screenshot({
          path: `${artifactDir}/${shot.name}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }

    const cancel = dialog.getByRole("button", { name: "Cancel" });
    await cancel.click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => commands.length).toBe(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__boundaryMediaEvents?.some(
              (event) => event.type === "pause",
            ) ?? false,
        ),
      )
      .toBe(true);

    await mark.click();
    dialog = page.getByRole("dialog", { name: "Adjust boundary" });
    await expect(dialog).toBeVisible();
    const applyOffset = dialog.getByRole("spinbutton", {
      name: "Change join by (seconds)",
    });
    await applyOffset.fill("1.500");
    await expect
      .poll(async () => Number(await applyOffset.inputValue()))
      .toBeCloseTo(1.5, 3);
    const applyResponse = page.waitForResponse((response) => {
      if (
        !response.url().includes("/api/document/command") ||
        response.request().method() !== "POST"
      ) {
        return false;
      }
      return (
        (response.request().postDataJSON() as DocumentCommand).type ===
        "RollClipJoin"
      );
    });
    await dialog.getByRole("button", { name: "Apply" }).click();
    const response = await applyResponse;
    expect(response.ok()).toBe(true);
    applied += 1;
    await expect(dialog).toBeHidden();
    expect(
      commands.filter((command) => command.type === "RollClipJoin"),
    ).toHaveLength(1);
    const applyPayload = commands.find(
      (command) => command.type === "RollClipJoin",
    )?.payload;
    expect(applyPayload?.delta_sec).toBeCloseTo(1.5, 3);
    expect(applyPayload?.expected_token).toBeTruthy();

    await page.reload();
    const restoredResponse = await page.request.get(
      `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
    );
    expect(restoredResponse.ok()).toBe(true);
    const restored = (await restoredResponse.json()) as ProjectView;
    const activeWord = restored.transcript?.utterances
      .flatMap((utterance) => utterance.words ?? [])
      .find(
        (word) =>
          word.text.toLowerCase() === "dissatisfied" &&
          word.start === 5.37 &&
          word.mappable,
      );
    expect(
      activeWord,
      "the applied boundary restores dissatisfied after reload",
    ).toBeTruthy();

    await openTranscript(page);
    const restoredBoundary = restored.edit_boundaries?.find(
      (candidate) => candidate.left_clip_id === boundary.left_clip_id,
    );
    const dragMark = restoredBoundary
      ? page.locator(
          `.edit-boundary-mark[data-boundary-id="${restoredBoundary.id}"]`,
        )
      : page.locator(".edit-boundary-mark").first();
    await expect(dragMark).toBeVisible();
    await dragMark.scrollIntoViewIfNeeded();
    const initial = await dragMark.boundingBox();
    expect(initial).toBeTruthy();
    const x = initial!.x + initial!.width / 2;
    const y = initial!.y + initial!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 4, y);
    await page.keyboard.down("Shift");
    await page.mouse.move(x + 6, y);
    await page.keyboard.up("Shift");
    await page.mouse.move(x + 8, y);
    await page.keyboard.down("Shift");
    await page.mouse.move(x + 10, y);
    await expect(page.locator(".edit-boundary-preview")).toContainText(
      "Fine drag",
    );
    const moved = await dragMark.boundingBox();
    expect(moved).toBeTruthy();
    expect(moved!.x + moved!.width / 2).toBeCloseTo(x + 10, 0);
    await page.keyboard.press("Escape");
    await page.keyboard.up("Shift");
    await page.mouse.up();
    await expect(page.locator("body")).not.toHaveClass(/is-boundary-dragging/);
    expect(
      commands.filter(
        (command) =>
          command.type === "RollClipJoin" || command.type === "TrimClipEdge",
      ),
    ).toHaveLength(1);
  } finally {
    await page.keyboard.up("Shift").catch(() => undefined);
    await page.mouse.up().catch(() => undefined);
    for (let index = 0; index < applied; index += 1) {
      await postDocumentCommand(page, CLIENT_ID, "UndoHistory", {
        rerender: false,
      });
    }
  }
});
