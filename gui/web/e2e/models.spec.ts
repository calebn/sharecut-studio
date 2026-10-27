import { expect, test } from "@playwright/test";
import { expectReadingSurfaceAxeClean, expectSurfaceAxeClean } from "./axe";
import { chooseHomeMenuItem, openHome } from "./home";
import {
  expectNoHorizontalScroll,
  expectTouchTargets,
  mockBootstrap,
  prepare,
  ROWS,
  row,
  runningJob,
  shot,
  THEMES,
  VIEWPORTS,
} from "./modelsMock";
import { openHostProject } from "./overlayReachability";

/**
 * The first-run Setup card on Home and the Models dialog against a mocked `/api/bootstrap/*`: nothing here
 * downloads anything. Set MODELS_SHOTS_DIR to also save one screenshot per viewport, theme and case.
 */

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`models ${viewport.name} ${theme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
      });

      test("Home offers one Setup card for the bundle, with the full list behind Choose, and downloads nothing", async ({
        page,
      }) => {
        await prepare(page, theme, false);
        const mock = await mockBootstrap(page);
        await openHome(page, { dismissSetup: false });
        const setup = page.getByRole("region", { name: "Get ShareCut ready" });
        await expect(setup).toBeVisible();
        await expect(
          setup.getByText(/One download, about 1\.6 GB\./),
        ).toBeVisible();
        await expect(
          setup.getByRole("button", { name: "Get ready" }),
        ).toBeEnabled();
        await expect(page.locator("li.model-row")).toHaveCount(0);
        await setup.getByRole("button", { name: "Choose…" }).click();
        const dialog = page.getByRole("dialog", { name: "Models" });
        await expect(dialog).toBeVisible();
        await expect(
          dialog
            .locator("li.model-row")
            .evaluateAll((els) =>
              els.map((el) => el.getAttribute("data-model")),
            ),
        ).resolves.toEqual([
          "whisper",
          "rnnoise",
          "word-aligner",
          "speaker-ecapa",
        ]);
        await expect(
          row(dialog, "Whisper").getByRole("combobox", {
            name: "Whisper size",
          }),
        ).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectTouchTargets(dialog);
        await expectReadingSurfaceAxeClean(page);
        await shot(page, viewport.name, theme, "setup-choose", true);
        expect(mock.runs).toEqual([]);
      });

      test("Get ready starts one download for the bundle and the card shows its live bar", async ({
        page,
      }) => {
        await prepare(page, theme, false);
        const mock = await mockBootstrap(page);
        await openHome(page, { dismissSetup: false });
        const setup = page.getByRole("region", {
          name: /ShareCut ready/,
        });
        await setup.getByRole("button", { name: "Get ready" }).click();
        await expect.poll(() => mock.runs.length).toBe(1);
        expect(mock.runs[0]).toMatchObject({
          components: ["whisper", "rnnoise"],
        });
        await expect(
          page.getByRole("region", { name: "Getting ShareCut ready" }),
        ).toBeVisible();
        await expect(setup.getByText("420 MB of 1.6 GB")).toBeVisible();
        await expect(
          setup.getByRole("button", { name: "Cancel" }),
        ).toBeEnabled();
        await expectNoHorizontalScroll(page);
        await expectReadingSurfaceAxeClean(page);
        await shot(page, viewport.name, theme, "setup-downloading", true);
      });

      test("Models opens from Home with the skip flag and shows every state", async ({
        page,
      }) => {
        await prepare(page, theme, true);
        const rows = ROWS.map((r) => ({ ...r }));
        rows[0]!.state = "installed";
        rows[1]!.state = "update_needed";
        const failure = {
          kind: "http",
          status: 404,
          plain: "The download server doesn't have the speaker model.",
        };
        const mock = await mockBootstrap(page, {
          rows,
          events: () =>
            `retry: 3600000\n\ndata: ${JSON.stringify({
              job: {
                id: "job-1",
                kind: "bootstrap",
                components: ["speaker-ecapa"],
                whisper_model: "large-v3-turbo",
                status: "error",
                error: failure.plain,
                failure,
                result: {
                  results: {
                    "speaker-ecapa": {
                      ok: false,
                      error: failure.plain,
                      failure,
                    },
                  },
                },
              },
            })}\n\n`,
        });
        await openHome(page, { dismissSetup: false });
        await expect(
          page.getByRole("region", { name: "Get ShareCut ready" }),
        ).toHaveCount(0);
        await chooseHomeMenuItem(page, "Models");
        const dialog = page.getByRole("dialog", { name: "Models" });
        await expect(dialog).toBeVisible();
        await expect(row(dialog, "Whisper").getByRole("status")).toHaveText(
          "Installed",
        );
        await expect(
          row(dialog, "Noise reduction (RNNoise)").getByRole("status"),
        ).toHaveText("Update available");
        await expect(
          row(dialog, "Noise reduction (RNNoise)").getByRole("button", {
            name: "Update Noise reduction (RNNoise)",
          }),
        ).toBeEnabled();
        await expect(
          row(dialog, "Word aligner").getByRole("status"),
        ).toHaveText("Not downloaded");
        await row(dialog, "Speaker model")
          .getByRole("button", { name: "Download Speaker model" })
          .click();
        const failed = row(dialog, "Speaker model");
        await expect(failed.getByRole("alert")).toHaveText(failure.plain);
        await expect(failed.getByRole("status")).toHaveText("Download failed");
        await expect(
          failed.getByText(/Try again in a few minutes/),
        ).toBeVisible();
        await expect(
          failed.getByRole("button", { name: "Retry Speaker model" }),
        ).toBeEnabled();
        expect(mock.runs).toHaveLength(1);
        await expectNoHorizontalScroll(page);
        await expectTouchTargets(dialog);
        await expectReadingSurfaceAxeClean(page);
        await shot(page, viewport.name, theme, "dialog-states");
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      });

      test("a 409 on Download adopts the running job and disables the other buttons with a reason", async ({
        page,
      }) => {
        await prepare(page, theme, true);
        const mock = await mockBootstrap(page, {
          runResponse: (_body, m) => {
            m.job = runningJob(["whisper"]);
            return {
              status: 409,
              headers: { "X-Sharecut-Error-Code": "bootstrap_job_running" },
              body: {
                detail: "Another download is already running (whisper)",
                running: ["whisper"],
                cancelling: false,
              },
            };
          },
        });
        await openHome(page, { dismissSetup: false });
        await chooseHomeMenuItem(page, "Models");
        const dialog = page.getByRole("dialog", { name: "Models" });
        await expect(dialog).toBeVisible();

        // Short landscape: the sheet body scrolls and the first row's action stays reachable.
        const body = dialog.locator(".command-palette-body");
        const scrolls = await body.evaluate(
          (el) => el.scrollHeight > el.clientHeight,
        );
        if (viewport.height <= 400) {
          expect(scrolls, "the sheet body scrolls on a short screen").toBe(
            true,
          );
        }
        const whisperDownload = row(dialog, "Whisper").getByRole("button", {
          name: "Download Whisper",
        });
        await whisperDownload.scrollIntoViewIfNeeded();
        await expect(whisperDownload).toBeInViewport();

        await row(dialog, "Word aligner")
          .getByRole("button", { name: "Download Word aligner" })
          .click();
        await expect.poll(() => mock.runs.length).toBe(1);
        const bar = row(dialog, "Whisper").getByRole("progressbar");
        await expect(bar).toHaveAttribute("aria-valuetext", "420 MB of 1.6 GB");
        for (const [label, name] of [
          ["Noise reduction (RNNoise)", "Download Noise reduction (RNNoise)"],
          ["Word aligner", "Download Word aligner"],
          ["Speaker model", "Download Speaker model"],
        ] as const) {
          const button = row(dialog, label).getByRole("button", { name });
          await expect(button).toBeDisabled();
          await expect(button).toHaveAccessibleDescription(
            "Another download is running",
          );
        }
        await expect(
          row(dialog, "Whisper").getByRole("button", {
            name: "Cancel Whisper download",
          }),
        ).toBeEnabled();
        expect(mock.runs).toHaveLength(1);
        await expectNoHorizontalScroll(page);
        await expectTouchTargets(dialog);
        await expectReadingSurfaceAxeClean(page);
        await shot(page, viewport.name, theme, "dialog-busy-409");
      });
    });
  }
}

test.describe("models palette command 1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const theme of THEMES) {
    test(`Manage models… opens the dialog from a project (${theme})`, async ({
      page,
    }) => {
      await prepare(page, theme, true);
      const mock = await mockBootstrap(page);
      await openHostProject(page);
      await page.keyboard.press("Shift+Slash");
      const search = page.getByRole("combobox", { name: "Search commands" });
      await expect(search).toBeVisible();
      await search.fill("Manage models");
      await expect(
        page.getByRole("option", { name: /Manage models…/ }),
      ).toBeVisible();
      await page.getByRole("option", { name: /Manage models…/ }).click();
      const dialog = page.getByRole("dialog", { name: "Models" });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("li.model-row")).toHaveCount(4);
      await expectSurfaceAxeClean(page, ".command-palette-panel");
      await shot(page, "1440x900", theme, "palette-opens-dialog");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(mock.runs).toEqual([]);
    });
  }
});

test.describe("models dialog in a project on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("rises as a bottom sheet with every row reachable", async ({ page }) => {
    await prepare(page, "light", true);
    const mock = await mockBootstrap(page);
    await openHostProject(page);
    await page.keyboard.press("Shift+Slash");
    await page
      .getByRole("combobox", { name: "Search commands" })
      .fill("Manage models");
    await page.getByRole("option", { name: /Manage models…/ }).click();
    const dialog = page.getByRole("dialog", { name: "Models" });
    await expect(dialog).toBeVisible();
    const panel = dialog.locator(".command-palette-panel");
    // The sheet rises into place; wait for it to settle on the bottom edge.
    await expect
      .poll(async () => {
        const box = await panel.boundingBox();
        return box && Math.round(box.y + box.height);
      })
      .toBe(844);
    const last = row(dialog, "Speaker model").getByRole("button", {
      name: "Download Speaker model",
    });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await expectNoHorizontalScroll(page);
    await expectSurfaceAxeClean(page, ".command-palette-panel");
    await shot(page, "390x844", "light", "palette-sheet");
    expect(mock.runs).toEqual([]);
  });
});
