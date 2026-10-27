import { expect, type Page, test } from "@playwright/test";
import { AUTO_MIX_PREF_KEY } from "../src/hooks/autoMixPref";
import { expectFitsViewport } from "./overlayReachability";
import { openPhoneTimeline } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { deliverPage, openProject, selectTool, startExport } from "./stageNav";

const PHONE_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
] as const;

const CANCEL_REASON = /still starting/i;

async function cutThroughRailThenUndo(
  page: Page,
  pathParam: string,
  beforeUndo: () => Promise<void>,
): Promise<void> {
  const clipCount = async () => {
    const res = await page.request.get(
      `/api/project?path=${pathParam}&phase=full`,
    );
    const body = (await res.json()) as {
      clips: { tracks: Record<string, unknown[]> };
    };
    return Object.values(body.clips.tracks).reduce(
      (sum, clips) => sum + clips.length,
      0,
    );
  };
  const before = await clipCount();
  const rail = page.getByRole("group", { name: "Editing tools" });
  await page.getByRole("slider", { name: "Timeline position" }).focus();
  await page.keyboard.press("ArrowRight");
  await page
    .getByRole("button", { name: "Select reference clip at 00:00.000, 1m 0s" })
    .click();
  await page
    .getByRole("dialog", { name: "reference clip" })
    .getByRole("button", { name: "Close" })
    .click();
  await selectTool(page, "blade");
  await rail.getByRole("button", { name: "Blade cut", exact: true }).click();
  await page
    .getByRole("dialog", { name: /^Cut at/ })
    .getByRole("button", { name: "Cut", exact: true })
    .click();
  await expect.poll(clipCount).toBeGreaterThan(before);
  await beforeUndo();
  await page
    .locator(".sys-header-history")
    .getByRole("button", { name: /^Undo/ })
    .click();
  await expect.poll(clipCount).toBe(before);
}

for (const viewport of PHONE_VIEWPORTS) {
  test(`phone ${viewport.width}x${viewport.height}: Export right after Undo waits for the mix rebuild and finishes`, async ({
    page,
  }) => {
    await page.setViewportSize(PHONE_VIEWPORTS[0]);
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, "on");
    }, AUTO_MIX_PREF_KEY);
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      await expect(page.locator(".stage-frame--phone")).toBeVisible();
      await openPhoneTimeline(page);
      let rebuildStarted!: () => void;
      const rebuildLive = new Promise<void>((resolve) => {
        rebuildStarted = resolve;
      });
      let releaseExport!: () => void;
      const exportGate = new Promise<void>((resolve) => {
        releaseExport = resolve;
      });
      let armed = false;
      await page.route("**/api/pipeline/render-preview", async (route) => {
        if (!armed) {
          await route.fallback();
          return;
        }
        try {
          const response = await route.fetch();
          await route.fulfill({ response });
        } finally {
          rebuildStarted();
        }
      });
      await cutThroughRailThenUndo(
        page,
        encodeURIComponent(projectPath),
        async () => {
          armed = true;
        },
      );
      const exportStatuses: number[] = [];
      await page.route("**/api/export/deliverables", async (route) => {
        await rebuildLive;
        await exportGate;
        const response = await route.fetch();
        exportStatuses.push(response.status());
        await route.fulfill({ response });
      });

      await page.setViewportSize(viewport);
      try {
        await startExport(page);
        const deliver = deliverPage(page);

        await expect(deliver.getByText(/Starting export…/)).toBeVisible();
        const cancel = deliver.getByRole("button", { name: "Cancel" });
        await expect(cancel).toBeDisabled();
        const reason = deliver.getByText(CANCEL_REASON);
        await expect(reason).toBeVisible();
        await expect(cancel).toHaveAttribute(
          "aria-describedby",
          (await reason.getAttribute("id")) ?? "",
        );
        await expectFitsViewport(page, cancel);
        await expectFitsViewport(page, reason);
      } finally {
        releaseExport();
      }

      const deliver = deliverPage(page);
      await expect(deliver).toContainText(/Exported \d+ files? to export\//);
      await expect(deliver).not.toContainText(/Export failed|pipeline-slot/);
      expect(exportStatuses).toEqual([200]);
    });
  });
}
