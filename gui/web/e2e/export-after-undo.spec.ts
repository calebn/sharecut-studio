import { expect, test } from "@playwright/test";
import { AUTO_MIX_PREF_KEY } from "../src/hooks/autoMixPref";
import { withShareableProject } from "./shareableProject";
import { deliverPage, startExport } from "./stageNav";

test("Export started right after Undo waits for the mix rebuild and finishes", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, "on");
  }, AUTO_MIX_PREF_KEY);
  await withShareableProject(async (projectPath) => {
    const pathParam = encodeURIComponent(projectPath);
    await page.goto(`/?project=${pathParam}`);
    const block = page.locator(".lane-row").first().locator(".clip-block");
    await expect(block).toHaveCount(1);
    const clipId = await block.getAttribute("data-clip-id");
    const fadeIn = async () => {
      const res = await page.request.get(
        `/api/project?path=${pathParam}&phase=full`,
      );
      const project = (await res.json()) as {
        clips: {
          tracks: Record<string, Array<{ id: string; fade_in_ms: number }>>;
        };
      };
      return Object.values(project.clips.tracks)
        .flat()
        .find((clip) => clip.id === clipId)?.fade_in_ms;
    };
    await block.locator(".fade-corner.in").focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(fadeIn).toBe(1);

    let rebuildStarted!: () => void;
    const rebuildLive = new Promise<void>((resolve) => {
      rebuildStarted = resolve;
    });
    await page.route("**/api/pipeline/render-preview", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response });
      rebuildStarted();
    });
    const exportStatuses: number[] = [];
    await page.route("**/api/export/deliverables", async (route) => {
      await rebuildLive;
      const response = await route.fetch();
      exportStatuses.push(response.status());
      await route.fulfill({ response });
    });

    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(fadeIn).toBe(0);
    await startExport(page);
    const deliver = deliverPage(page);

    await expect(deliver).toContainText(/Exported \d+ files? to export\//);
    await expect(deliver).not.toContainText(/Export failed|pipeline-slot/);
    expect(exportStatuses).toEqual([200]);
  });
});
