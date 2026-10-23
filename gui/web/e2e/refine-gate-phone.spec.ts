import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openSuggestedPendingEdit } from "./pendingEdit";

const SERVER_TEXT =
  "Transcript refine is required before focus/tighten/NL edits. Run podcast-transcript-refine (whole-episode pass), then `podcast transcript refine-done` / `transcript_refine_done_tool`, or `podcast transcript refine-waive --reason ...` / `transcript_refine_waive_tool`.";

for (const [width, height] of [
  [390, 844],
  [320, 568],
] as const) {
  test(`a refused Approve on a ${width}x${height} phone offers Waive and keeps the timeline in view`, async ({
    page,
  }) => {
    await page.route("**/api/document/command**", async (route) => {
      const body = route.request().postDataJSON() as { type?: string } | null;
      if (body?.type === "ApproveEdits") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          headers: { "X-Sharecut-Error-Code": "transcript_refine_required" },
          body: JSON.stringify({ detail: SERVER_TEXT }),
        });
        return;
      }
      await route.continue();
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await openSuggestedPendingEdit(page, e2eProjectPath);
    await page.setViewportSize({ width, height });
    await page.getByRole("button", { name: "Timeline" }).click();
    const sheet = page.locator(".bottom-sheet--compact");
    await expect(sheet).toBeVisible();
    await sheet
      .getByRole("button", { name: "Approve", exact: true })
      .first()
      .click();
    const waive = sheet.getByRole("button", { name: "Waive with reason" });
    await expect(waive).toBeVisible();

    await expect(page.getByText(/refinement is (required|done)/i)).toHaveCount(
      1,
    );
    await expect(page.locator("body")).not.toContainText(
      /podcast transcript|ApproveEdits|refine-waive|transcript_refine/,
    );
    await expect(
      page.getByRole("region", { name: /^Needs attention/ }),
    ).toHaveCount(0);
    await expect(waive).toBeInViewport();

    const layout = await page.evaluate(() => {
      const box = (selector: string) =>
        document.querySelector(selector)?.getBoundingClientRect() ?? null;
      const button = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Waive with reason",
      );
      const rect = button?.getBoundingClientRect();
      const recovery = document.querySelector(".transcript-refine-recovery");
      return {
        sheetTop: box(".bottom-sheet--compact")?.top ?? null,
        laneTop: box(".timeline-scroll")?.top ?? null,
        waiveHit:
          rect === undefined
            ? null
            : document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              ) === button,
        recoveryScrolls: recovery
          ? recovery.scrollHeight > recovery.clientHeight + 1
          : null,
      };
    });
    expect(layout.waiveHit, "Waive is reachable, not under a banner").toBe(
      true,
    );
    expect(layout.recoveryScrolls, "the form has no inner scroller").toBe(
      false,
    );
    // 13.625rem of transport, ruler and lanes stays above the sheet.
    expect(layout.sheetTop).toBeGreaterThanOrEqual(200);
  });
}
