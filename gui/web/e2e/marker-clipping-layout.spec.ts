import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { createRelocatedE2eProject } from "./liveProject";
import { switchE2eProject, withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";

test("the timeline reserves room for clipping flags above the first track", async ({
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await openProject(page, projectPath, { stage: "edit" });
      const markers = page.locator(".marker-lane");
      const clipping = markers.locator(".marker-row.clipping");
      const markerRow = markers.locator(".sys-markers");
      const track = page.locator(".lane-row[data-track-id]").first();

      await expect(
        clipping.getByRole("button", { name: /^Clipping on / }),
      ).toBeVisible();
      await expect(markerRow).toBeVisible();
      await expect(track).toBeVisible();
      const [lane, flagRow, pins, firstTrack] = await Promise.all([
        markers.boundingBox(),
        clipping.boundingBox(),
        markerRow.boundingBox(),
        track.boundingBox(),
      ]);
      if (!lane || !flagRow || !pins || !firstTrack)
        throw new Error("Timeline rows did not render");

      expect(flagRow.height).toBe(pins.height);
      expect(lane.height).toBe(flagRow.height + pins.height);
      expect(pins.y + pins.height).toBeLessThanOrEqual(flagRow.y + 0.5);
      expect(flagRow.y + flagRow.height).toBeLessThanOrEqual(
        firstTrack.y + 0.5,
      );
      expect(lane.y + lane.height).toBeLessThanOrEqual(firstTrack.y + 0.5);
    },
    switchE2eProject,
    (prefix) => {
      const fixture = createRelocatedE2eProject(prefix);
      const project = JSON.parse(fs.readFileSync(fixture.projectPath, "utf8"));
      const source = project.sources[0];
      const clip = project.timeline.clips.find(
        (row: { track_id: string }) => row.track_id === source.speaker,
      );
      if (!clip) throw new Error("Synthetic clip is missing");
      clip.source_id = source.id;
      source.clipping_regions = [
        { start_s: clip.source_start + 1, end_s: clip.source_start + 1.2 },
      ];
      fs.writeFileSync(
        fixture.projectPath,
        `${JSON.stringify(project, null, 2)}\n`,
      );
      return fixture;
    },
  );
});
