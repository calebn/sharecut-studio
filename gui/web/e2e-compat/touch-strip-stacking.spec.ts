import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import { newFinger } from "../e2e/finger";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { switchE2eProject } from "../e2e/shareableProject";
import {
  buildFixture,
  centerOf,
  json,
  lane,
  save,
  setZoom,
} from "../e2e/touchTimeline";

/*
 * #1051 round 4: the shell row beside the compact strip (the phone's mode
 * nav, or the status row with the Pipeline chip on a phone held sideways)
 * floated over the strip when iOS rubber-banded the page. Here the bounce is
 * reproduced by moving the shell as the bounce does while the fixed strip
 * stays, and the strip's own stow slide is frozen halfway. Neither may draw
 * a shell row over the strip, or the strip over the row. STACKING_RUN names
 * the build the screenshots come from (before/after evidence).
 */

const CLIENT_ID = "e2e-strip-stacking";
const RUN = process.env.STACKING_RUN ?? "after";
const SIZES = {
  "portrait-360": { width: 360, height: 800 },
  "landscape-844": { width: 844, height: 390 },
} as const;
/** How far the page moves in a rubber-band bounce here (px). */
const BOUNCE_PX = 24;

test.use({ hasTouch: true });
test.describe.configure({ timeout: 240_000 });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-strip-stacking-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

/** What is drawn at the middle of the shell row under the strip, and on it. */
async function stacking(page: Page) {
  return page.evaluate(() => {
    const row = document.querySelector(".mobile-nav, .daw-shell > .status-bar");
    const strip = document.querySelector(".bottom-sheet");
    if (!row || !strip) throw new Error("no shell row or strip");
    const r = row.getBoundingClientRect();
    const s = strip.getBoundingClientRect();
    const owner = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest(".bottom-sheet")
        ? "strip"
        : el?.closest(".mobile-nav, .status-bar")
          ? "row"
          : (el?.className ?? null);
    };
    const x = s.left + s.width / 2;
    return {
      row: row.className,
      rowTop: Math.round(r.top),
      stripBottom: Math.round(s.bottom),
      /** The strip's bottom edge, which a bounced row reaches up over. */
      stripEdge: owner(x, s.bottom - 4),
      /** Inside the row, where the strip's painted box may reach. */
      rowMiddle: owner(x, r.top + r.height / 2),
    };
  });
}

for (const [size, viewport] of Object.entries(SIZES)) {
  test(`no shell row draws over the strip, nor the strip over it: ${size}`, async ({
    page,
    context,
    browserName,
  }, info) => {
    const shot = async (name: string) =>
      save(
        info,
        `stacking-${RUN}-${size}-${browserName}-${name}.png`,
        await page.screenshot(),
      );
    await page.setViewportSize(viewport);
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await buildFixture(page, projectPath, CLIENT_ID);
    await page.goto(
      `/?project=${encodeURIComponent(projectPath)}&lab=touch-chooser`,
    );
    await expect(page.locator(".daw-shell")).toBeVisible();
    if (viewport.width < 768) await openPhoneTimeline(page);
    await setZoom(page, 3);
    const finger = await newFinger(context, page, browserName);
    await finger.down(
      await centerOf(
        page,
        `${lane} [data-hit-kind="envelope-point"][data-hit-id="env-c"]`,
      ),
    );
    await page.waitForTimeout(60);
    await finger.up();
    await expect(page.locator(".bottom-sheet--compact")).toBeVisible();
    await page.waitForTimeout(600);
    await shot("1-strip");
    const resting = await stacking(page);

    // An iOS rubber-band: in-flow rows move, the fixed strip does not.
    // Relative offset, not a transform, so no new stacking context forms.
    await page.evaluate((px) => {
      const shell = document.querySelector<HTMLElement>(".daw-shell");
      shell?.style.setProperty("position", "relative");
      shell?.style.setProperty("top", `-${px}px`);
    }, BOUNCE_PX);
    await shot("2-page-bounce");
    const bounce = await stacking(page);
    await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>(".daw-shell");
      shell?.style.removeProperty("position");
      shell?.style.removeProperty("top");
    });

    // The stow slide (any timeline drag), frozen halfway.
    await page.evaluate(() => {
      document.querySelector(".bottom-sheet-root")?.classList.add("is-stowed");
    });
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        const timing = animation.effect?.getComputedTiming();
        if (!timing || typeof timing.duration !== "number") continue;
        animation.pause();
        animation.currentTime = timing.duration / 2;
      }
    });
    await shot("3-stow-halfway");
    const stowing = await stacking(page);

    const overscroll = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).overscrollBehaviorY,
      body: getComputedStyle(document.body).overscrollBehaviorY,
      timeline: getComputedStyle(
        document.querySelector(".timeline-scroll") as Element,
      ).overscrollBehaviorY,
    }));
    json(info, `stacking-${RUN}-${size}-${browserName}`, {
      resting,
      bounce,
      stowing,
      overscroll,
    });

    expect(resting).toMatchObject({ stripEdge: "strip", rowMiddle: "row" });
    // The bounced row reaches up into the strip: the strip stays on top.
    expect(bounce.stripEdge).toBe("strip");
    // Halfway off, the strip is clipped to its slot: the row stays clear.
    expect(stowing.rowMiddle).toBe("row");
    expect(overscroll).toEqual({
      html: "none",
      body: "none",
      timeline: "contain",
    });
  });
}
