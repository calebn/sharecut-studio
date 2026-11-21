import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject } from "./shareableProject";
import { openPanel, openProject } from "./stageNav";
import { projectJson } from "./touchTimeline";

test.use({ viewport: { width: 1024, height: 576 }, deviceScaleFactor: 2 });

test("a Script cut keeps the timeline geometry and waveforms through the edit", async ({
  page,
}) => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-script-cut-");
  try {
    await switchE2eProject(fixture.projectPath);
    await openProject(page, fixture.projectPath);
    await openPanel(page, "transcript");
    const zoom = page.getByRole("button", { name: /^Zoom in/ });
    for (let step = 0; step < 4; step++) await zoom.click();
    const words = page.locator(
      '.sys-script-body .sys-script-word[data-word-key^="reference:"]',
    );
    await words.nth(2).click();
    await words.nth(8).click({ modifiers: ["Shift"] });
    await expect(words.nth(8)).toHaveAttribute("data-selected");
    const cut = page
      .getByRole("group", { name: "Selection actions" })
      .getByRole("button", { name: "Cut", exact: true });
    await expect(cut).toBeVisible();

    const before = await projectJson(page, fixture.projectPath);
    const clipCount = await page.locator(".clip-hit").count();
    const trace = page.evaluate(
      async ({ button, clipCount }) => {
        function readFrame() {
          return {
            ruler: document
              .querySelector(".timeline-ruler")
              ?.getBoundingClientRect().top,
            lanes: Array.from(
              document.querySelectorAll<HTMLElement>(
                ".lane-row[data-track-id]",
              ),
            ).map((lane) => {
              const { top, height } = lane.getBoundingClientRect();
              // Read a single scanline to distinguish a mounted canvas from
              // one which actually contains a warmed waveform bitmap.
              const painted = Array.from(
                lane.querySelectorAll<HTMLCanvasElement>(
                  "canvas.clip-waveform-tile",
                ),
              ).some((canvas) => {
                const box = canvas.getBoundingClientRect();
                return (
                  box.left < innerWidth &&
                  box.right > 0 &&
                  box.top < innerHeight &&
                  box.bottom > 0 &&
                  canvas
                    .getContext("2d")
                    ?.getImageData(
                      0,
                      Math.floor(canvas.height / 2),
                      canvas.width,
                      1,
                    )
                    .data.some((alpha, i) => i % 4 === 3 && alpha > 0)
                );
              });
              return { track: lane.dataset.trackId, top, height, painted };
            }),
          };
        }

        let baseline = readFrame();
        const deadline = performance.now() + 15000;
        while (
          baseline.lanes.length !== 2 ||
          !baseline.lanes.every((lane) => lane.painted)
        ) {
          if (performance.now() > deadline)
            throw new Error("Waveforms did not warm before the cut");
          await new Promise(requestAnimationFrame);
          baseline = readFrame();
        }
        button.setAttribute("data-frame-probe-ready", "");
        let clicked = false;
        button.addEventListener(
          "click",
          () => {
            clicked = true;
          },
          { once: true, capture: true },
        );
        const frames: ReturnType<typeof readFrame>[] = [];
        let changedAt: number | undefined;
        while (performance.now() <= deadline) {
          await new Promise(requestAnimationFrame);
          if (!clicked) continue;
          frames.push(readFrame());
          if (document.querySelectorAll(".clip-hit").length !== clipCount)
            changedAt ??= performance.now();
          if (changedAt !== undefined && performance.now() - changedAt > 250)
            return { baseline, frames, changed: true };
        }
        return { baseline, frames, changed: false };
      },
      { button: (await cut.elementHandle())!, clipCount },
    );
    await expect(cut).toHaveAttribute("data-frame-probe-ready", "");
    await cut.click();
    const { baseline, frames, changed } = await trace;
    expect(changed).toBe(true);
    expect(frames.length).toBeGreaterThan(2);
    for (const frame of frames) expect(frame).toEqual(baseline);
    const after = await projectJson(page, fixture.projectPath);
    expect(after.clips.tracks.reference?.length).toBeGreaterThan(
      before.clips.tracks.reference?.length ?? 0,
    );
  } finally {
    await switchE2eProject(e2eProjectPath);
    removeRelocatedE2eProject(fixture.workspaceDir);
  }
});
