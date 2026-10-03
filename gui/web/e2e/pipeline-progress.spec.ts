import { expect, test } from "@playwright/test";
import { createEditorProfiler } from "./editorProfile";
import { replayPipelineProgress } from "./editorProgress";
import { e2eProjectPath } from "./env";

for (const layout of [
  { name: "desktop-short", viewport: { width: 1280, height: 600 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
]) {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`pipeline progress remains visible (${layout.name}, ${reducedMotion})`, async ({
      page,
      headless,
    }, info) => {
      await page.setViewportSize(layout.viewport);
      await page.emulateMedia({ reducedMotion });
      const recorder = await createEditorProfiler(
        page,
        await page.context().newCDPSession(page),
        info,
        e2eProjectPath,
        0,
        headless,
        {
          scenario: `progress-visibility-${layout.name}-${reducedMotion}`,
          requiredCoverage: ["synthetic-progress"],
          resources: {
            waveforms: "prebuilt",
            server: "fresh-process",
            browser: "fresh-context",
            osCache: "uncontrolled",
            media: [],
          },
        },
      );
      let failure: unknown;
      try {
        await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await replayPipelineProgress(page, recorder, e2eProjectPath);
        const cancel = page.getByRole("button", {
          name: "Cancel",
          exact: true,
        });
        await cancel.scrollIntoViewIfNeeded();
        await expect(cancel).toBeInViewport();
        await page
          .locator('.pipeline-bar[role="progressbar"]')
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: recorder.artifactPath("responsive-progress.png"),
        });
        const transition = await page
          .locator(".pipeline-bar-fill")
          .evaluate((element) => getComputedStyle(element).transitionDuration);
        if (reducedMotion === "reduce") expect(transition).toBe("0s");
        else expect(transition).not.toBe("0s");
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        await recorder.finish(failure);
      }
    });
  }
}
