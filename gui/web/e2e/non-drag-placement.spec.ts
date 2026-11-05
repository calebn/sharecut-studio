import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { read } from "./lifecycleAudit";
import { createRelocatedE2eProject } from "./liveProject";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { ensureInspected, setScrub } from "./stageNav";

function placementFixture(prefix: string) {
  const fixture = createRelocatedE2eProject(prefix);
  const project = read(fixture.projectPath);
  const source = project.timeline.clips[0];
  project.timeline.clips = [
    {
      ...source,
      id: "placement-first",
      source_start: 0,
      source_end: 2,
      timeline_start: 7.02,
    },
    {
      ...source,
      id: "placement-second",
      source_start: 2,
      source_end: 4,
      timeline_start: 27.02,
    },
  ];
  project.mix.automation_envelopes = [];
  fs.writeFileSync(
    fixture.projectPath,
    `${JSON.stringify(project, null, 2)}\n`,
  );
  return fixture;
}

const starts = (projectPath: string) =>
  Object.fromEntries(
    read(projectPath).timeline.clips.map(
      (clip: { id: string; timeline_start: number }) => [
        clip.id,
        clip.timeline_start,
      ],
    ),
  );

test.use({ viewport: { width: 1440, height: 900 } });

test("the Start Scrub field moves a clip to a typed time in one save and Escape saves nothing", async ({
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await openHostShare(page, projectPath);
      const clip = page.locator(
        '.lane-row[data-track-id="reference"] .clip-block[data-clip-id="placement-first"]',
      );
      await clip.locator(".clip-hit").click();
      await ensureInspected(page);
      const start = page.getByRole("spinbutton", {
        name: "Start",
        exact: true,
      });
      const before = starts(projectPath);

      // Escape out of the text input leaves the file alone.
      await start.focus();
      await start.press("Enter");
      await page.keyboard.press("Control+A");
      await page.keyboard.type("9");
      await page.keyboard.press("Escape");
      expect(starts(projectPath)).toEqual(before);

      // A typed value commits one placement, with no Apply step.
      await setScrub(page, start, "7");
      await expect
        .poll(() => starts(projectPath)["placement-first"])
        .toBeCloseTo(7, 3);
      expect(starts(projectPath)["placement-second"]).toBe(
        before["placement-second"],
      );
    },
    undefined,
    placementFixture,
  );
});
