import { expect, test } from "@playwright/test";
import type { PipelineJobSnapshot } from "../src/types/pipeline";
import { expectSurfaceAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { setTheme, withAppearance } from "./theme";

const job: PipelineJobSnapshot = {
  id: "results-fit",
  kind: "pipeline",
  project_path: e2eProjectPath,
  from_step: null,
  only_step: null,
  status: "error",
  current: 3,
  total: 3,
  message: "Pipeline failed",
  error: null,
  elapsed_sec: 3,
  steps: [
    {
      name: "ingest_tracks",
      status: "ok",
      elapsed_sec: 1,
      error: null,
      summary: "2 tracks ingested",
    },
    {
      name: "transcribe_tracks",
      status: "ok",
      elapsed_sec: 2,
      error: null,
      summary:
        "2 transcripts reused; forced alignment unavailable: word aligner not downloaded",
    },
    {
      name: "export_deliverables",
      status: "error",
      elapsed_sec: 0,
      error:
        "Could not write export for recording_abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789.wav: permission denied",
      summary: "This summary must yield to the error",
    },
  ],
};

for (const { cell, theme, reducedMotion } of withAppearance([
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
])) {
  test(`pipeline results fit at ${cell.width}px in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(cell);
    await page.emulateMedia({
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    await page.route("**/api/pipeline/status*", (route) =>
      route.fulfill({
        json: { running: false, job, jobs: [job], running_count: 0 },
      }),
    );
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    if (cell.width < 768) {
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "More", exact: true })
        .click();
      await page
        .locator(".mobile-more-list")
        .getByRole("button", { name: "Pipeline", exact: true })
        .click();
    } else {
      await page
        .getByLabel("Editor panels")
        .getByRole("tab", { name: "Pipeline", exact: true })
        .click();
    }
    const table = page.locator(".pipeline-steps");
    await expect(table).toBeVisible();
    await setTheme(page, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(table.locator("thead")).toHaveText("StepStatusTimeSummary");
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(job.steps.length);
    for (const [index, step] of job.steps.entries()) {
      const cells = rows.nth(index).getByRole("cell");
      await expect(cells.nth(0)).toHaveText(step.name);
      await expect(cells.nth(1)).toHaveText(step.status);
      await expect(cells.nth(2)).not.toBeEmpty();
      await expect(cells.nth(3)).toHaveText(step.error ?? step.summary ?? "");
    }
    await table.scrollIntoViewIfNeeded();
    const geometry = await table.evaluate((element) => {
      const panel = element.closest(".pipeline-panel")!;
      const panelBounds = panel.getBoundingClientRect();
      const tableBounds = element.getBoundingClientRect();
      return {
        panelWidth: panel.clientWidth,
        panelScrollWidth: panel.scrollWidth,
        tableWidth: tableBounds.width,
        tableLeft: tableBounds.left,
        tableRight: tableBounds.right,
        panelLeft: panelBounds.left,
        panelRight: panelBounds.right,
        cells: Array.from(
          element.querySelectorAll<HTMLTableCellElement>("th, td"),
          (cell) => {
            const bounds = cell.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(cell);
            return {
              text: cell.textContent,
              column: cell.cellIndex,
              header: cell.tagName === "TH",
              textLines: range.getClientRects().length,
              clientWidth: cell.clientWidth,
              scrollWidth: cell.scrollWidth,
              clientHeight: cell.clientHeight,
              scrollHeight: cell.scrollHeight,
              textFits: Array.from(range.getClientRects()).every(
                (rect) =>
                  rect.left >= bounds.left - 1 &&
                  rect.right <= bounds.right + 1 &&
                  rect.top >= bounds.top - 1 &&
                  rect.bottom <= bounds.bottom + 1,
              ),
            };
          },
        ),
      };
    });
    await testInfo.attach("results-geometry", {
      body: JSON.stringify(geometry, null, 2),
      contentType: "application/json",
    });
    await testInfo.attach("results-table", {
      body: await table.screenshot(),
      contentType: "image/png",
    });
    await testInfo.attach("results-viewport", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    expect(geometry.panelScrollWidth).toBeLessThanOrEqual(
      geometry.panelWidth + 1,
    );
    expect(geometry.tableLeft).toBeGreaterThanOrEqual(geometry.panelLeft - 1);
    expect(geometry.tableRight).toBeLessThanOrEqual(geometry.panelRight + 1);
    for (const cell of geometry.cells) {
      if (cell.header || cell.column === 1 || cell.column === 2) {
        expect(cell.textLines, cell.text ?? "").toBe(1);
      }
      expect(cell.textFits, cell.text ?? "").toBe(true);
      expect(cell.scrollWidth, cell.text ?? "").toBeLessThanOrEqual(
        cell.clientWidth + 1,
      );
      expect(cell.scrollHeight, cell.text ?? "").toBeLessThanOrEqual(
        cell.clientHeight + 1,
      );
    }
    await expectSurfaceAxeClean(page, ".pipeline-steps");
  });
}
