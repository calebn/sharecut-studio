import fs from "node:fs";
import { expect } from "@playwright/test";
import { test } from "./interactionEvidence";
import { read, snapshot } from "./lifecycleAudit";
import { createRelocatedE2eProject } from "./liveProject";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";

const CLIP = "trim-undo";

function fixture(prefix: string) {
  const made = createRelocatedE2eProject(prefix);
  const project = read(made.projectPath);
  const clip = project.timeline.clips[0];
  clip.id = CLIP;
  clip.source_start = 10;
  clip.source_end = 20;
  clip.timeline_start = 5;
  clip.fade_in_ms = 0;
  clip.fade_out_ms = 0;
  project.mix.automation_envelopes = [];
  fs.writeFileSync(made.projectPath, `${JSON.stringify(project, null, 2)}\n`);
  return made;
}

for (const edge of [
  { kind: "trim", selector: ".trim-handle.in", saved: "Trim saved" },
  { kind: "fade", selector: ".fade-corner.in", saved: "Fade saved" },
] as const) {
  for (const input of ["keyboard", "mouse"] as const) {
    test(`desktop ${input} ${edge.kind}: the saved toast offers Undo that restores the clips`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await withShareableProject(
        async (projectPath) => {
          await openHostShare(page, projectPath);
          const block = page.locator(
            `[data-testid="timeline-clip"][data-clip-id="${CLIP}"]`,
          );
          await block.locator(".clip-hit").click();
          const handle = block.locator(edge.selector);
          const before = snapshot(projectPath);
          if (input === "keyboard") {
            await handle.focus();
            await page.keyboard.down("Shift");
            await page.keyboard.down("ArrowRight");
            await page.keyboard.up("ArrowRight");
            await page.keyboard.up("Shift");
          } else {
            const box = (await handle.boundingBox())!;
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x + 12, y, { steps: 4 });
            await page.mouse.move(x + 30, y, { steps: 4 });
            await page.mouse.up();
          }
          const toast = page.locator(".ui-toast-region--app .ui-toast");
          await expect(toast).toContainText(edge.saved);
          expect(snapshot(projectPath).clips).not.toEqual(before.clips);
          await toast.getByRole("button", { name: "Undo" }).click();
          await expect
            .poll(() => snapshot(projectPath).clips)
            .toEqual(before.clips);
        },
        undefined,
        fixture,
      );
    });
  }
}
