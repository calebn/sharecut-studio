import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { createRelocatedE2eProject } from "./liveProject";
import { silenceWav, withShareableProject } from "./shareableProject";

function overlapProject(
  prefix: string,
  placement: "edited" | "peer",
  start = 9.9996,
) {
  const fixture = createRelocatedE2eProject(prefix);
  const project = JSON.parse(fs.readFileSync(fixture.projectPath, "utf8"));
  const tracks = project.timeline.tracks
    .filter((track: { role: string }) => track.role === "dialogue")
    .slice(0, 2);
  for (const track of tracks) {
    track.media.duration_sec = 30;
    fs.writeFileSync(
      fixture.workspaceDir + "/" + track.media.path,
      silenceWav(30),
    );
    track.transcript = undefined;
  }
  if (start !== 9.9996) {
    project.sources = [
      { id: "overlap-alt", path: "raw/overlap-alt.wav", duration_sec: 30 },
    ];
    fs.writeFileSync(
      fixture.workspaceDir + "/raw/overlap-alt.wav",
      silenceWav(30),
    );
  }
  project.timeline.tracks = tracks;
  project.timeline.clips = [
    {
      id: "overlap-host",
      track_id: tracks[0].id,
      timeline_start: 0,
      source_start: 0,
      source_end: 10,
    },
    {
      id: "overlap-peer",
      track_id: tracks[1].id,
      timeline_start: 0,
      source_start: 0,
      source_end: 10,
    },
    {
      id: "overlap-next",
      track_id: tracks[placement === "edited" ? 0 : 1].id,
      timeline_start: start,
      source_id: start === 9.9996 ? null : "overlap-alt",
      source_start: start === 9.9996 ? 10 : 0,
      source_end: start === 9.9996 ? 20 : 19,
    },
  ];
  project.timeline.clips = project.timeline.clips.map((clip: object) => ({
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    mute_regions: [],
    source_id: null,
    ...clip,
  }));
  project.timeline.duration_sec = 20;
  project.transcripts = {};
  fs.writeFileSync(fixture.projectPath, JSON.stringify(project));
  return fixture;
}

for (const placement of ["edited", "peer"] as const) {
  test(
    "ripple carries an overlapping successor on the " + placement + " lane",
    async ({ page }) => {
      await withShareableProject(
        async (projectPath) => {
          await page.goto("/?project=" + encodeURIComponent(projectPath));
          const target = page.locator(
            '[data-clip-id="overlap-host"] .trim-handle.out',
          );
          await expect(target).toBeVisible();
          await target.focus();
          await page.keyboard.down("ArrowLeft");
          await page.keyboard.down("ArrowLeft");
          await page.keyboard.down("ArrowLeft");
          await expect(page.locator(".ripple-arrow")).not.toHaveCount(0);
          await page.keyboard.up("ArrowLeft");

          await expect
            .poll(() => {
              const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
              return project.timeline.clips.find(
                (clip: { id: string }) => clip.id === "overlap-host",
              ).source_end;
            })
            .toBeCloseTo(9.97, 8);

          const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
          const follower = project.timeline.clips.find(
            (clip: { id: string }) => clip.id === "overlap-next",
          );
          expect(follower).toMatchObject({
            id: "overlap-next",
            source_start: 10,
            source_end: 20,
            timeline_start: 9.9696,
            source_id: null,
          });
          expect(
            follower.timeline_start +
              follower.source_end -
              follower.source_start,
          ).toBeCloseTo(19.9696, 8);
        },
        undefined,
        (prefix) => overlapProject(prefix, placement),
      );
    },
  );
}

for (const placement of ["edited", "peer"] as const) {
  test(
    placement === "edited"
      ? "refuses a large overlap trim on the edited lane and saves the last valid draft"
      : "refuses a large overlap trim on the peer lane and saves the last valid draft",
    async ({ page }) => {
      await withShareableProject(
        async (projectPath) => {
          await page.goto("/?project=" + encodeURIComponent(projectPath));
          const anchor = page.locator('[data-clip-id="overlap-host"]');
          const handle = anchor.locator(".trim-handle.out");
          await expect(handle).toBeVisible();
          const bounds = await anchor.boundingBox();
          const grip = await handle.boundingBox();
          if (!bounds || !grip)
            throw new Error("Trim handle geometry unavailable");
          const zoom = bounds.width / 10;
          const x = grip.x + grip.width / 2;
          const y = grip.y + grip.height / 2;
          const original = JSON.parse(fs.readFileSync(projectPath, "utf8"));
          if (placement === "edited") {
            await handle.focus();
            await page.keyboard.down("Shift");
            for (let i = 0; i < 10; i += 1)
              await page.keyboard.down("ArrowLeft");
          } else {
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x - 0.5 * zoom, y);
          }
          const arrow = page.locator(".ripple-arrow").first();
          await expect(arrow).toBeVisible();
          const validArrow = await arrow.getAttribute("style");
          const validWidth = await anchor.evaluate(
            (el) => (el as HTMLElement).style.width,
          );
          if (placement === "edited") {
            for (let i = 0; i < 20; i += 1)
              await page.keyboard.down("ArrowLeft");
          } else {
            await page.mouse.move(x - 2 * zoom, y);
          }
          await expect(
            page
              .getByText(/Clip edit failed:.*before the timeline starts/)
              .first(),
          ).toBeVisible();
          expect(await arrow.getAttribute("style")).toBe(validArrow);
          expect(
            await anchor.evaluate((el) => (el as HTMLElement).style.width),
          ).toBe(validWidth);
          expect(JSON.parse(fs.readFileSync(projectPath, "utf8"))).toEqual(
            original,
          );
          if (placement === "edited") {
            await page.keyboard.up("ArrowLeft");
            await page.keyboard.up("Shift");
          } else {
            await page.mouse.up();
          }
          await expect
            .poll(
              () =>
                JSON.parse(
                  fs.readFileSync(projectPath, "utf8"),
                ).timeline.clips.find(
                  (c: { id: string }) => c.id === "overlap-host",
                ).source_end,
            )
            .toBeCloseTo(placement === "edited" ? 9 : 9.5, 6);
          const saved = JSON.parse(fs.readFileSync(projectPath, "utf8"));
          expect(
            saved.timeline.clips.find(
              (c: { id: string }) => c.id === "overlap-next",
            ),
          ).toMatchObject({
            timeline_start: expect.closeTo(placement === "edited" ? 0 : 0.5, 6),
            source_start: 0,
            source_end: 19,
          });
          await page.keyboard.press("Meta+z");
          await expect
            .poll(
              () =>
                JSON.parse(fs.readFileSync(projectPath, "utf8")).timeline.clips,
            )
            .toEqual(original.timeline.clips);
        },
        undefined,
        (prefix) => overlapProject(prefix, placement, 1),
      );
    },
  );
}
