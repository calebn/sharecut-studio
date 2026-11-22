import { expect, test } from "@playwright/test";
import { AUTO_MIX_PREF_KEY } from "../src/hooks/autoMixPref";
import { withShareableProject } from "./shareableProject";
import { createReviewShare, openGuestShare } from "./shareNavigation";
import { inspectSelection, openProject, runPaletteCommand } from "./stageNav";
import { withTwoBrowserPages } from "./twoBrowserPages";

test("an open Viewer clears its stale mix warning when the host refreshes", async ({
  browser,
}) => {
  await withShareableProject(async (projectPath) => {
    await withTwoBrowserPages(
      browser,
      { viewport: { width: 1280, height: 800 } },
      { viewport: { width: 1280, height: 800 } },
      async (host, viewer) => {
        await host.addInitScript((key) => {
          localStorage.setItem(key, "off");
        }, AUTO_MIX_PREF_KEY);
        await openProject(host, projectPath);
        const mixIsStale = async () => {
          const response = await host.request.get("/api/project", {
            params: { path: projectPath, phase: "full" },
          });
          expect(response.ok(), await response.text()).toBeTruthy();
          const { render_status } = (await response.json()) as {
            render_status: { premix: { is_stale: boolean } };
          };
          return render_status.premix.is_stale;
        };

        await runPaletteCommand(host, "Refresh mix");
        await expect.poll(mixIsStale, { timeout: 30_000 }).toBe(false);
        await openGuestShare(
          viewer,
          await createReviewShare(host, projectPath),
        );
        const warning = viewer.getByText("Mix out of date", { exact: true });
        await expect(warning).toHaveCount(0);

        await host.locator(".lane-row .clip-block").first().click();
        await inspectSelection(host);
        await host.getByRole("spinbutton", { name: "Gain" }).press("ArrowUp");
        await expect(warning).toBeVisible();

        const guestNavigations: string[] = [];
        viewer.on("framenavigated", (frame) => {
          if (frame === viewer.mainFrame()) guestNavigations.push(frame.url());
        });
        await runPaletteCommand(host, "Refresh mix");
        await expect(warning).toHaveCount(0, { timeout: 30_000 });
        expect(guestNavigations).toEqual([]);
      },
    );
  });
});
