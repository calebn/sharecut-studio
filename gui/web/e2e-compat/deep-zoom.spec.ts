import { expect, type Page, test } from "@playwright/test";
import {
  DEEP_ZOOM_TOLERANCE_PX,
  expectedLastRulerTick,
  HOUR_SEC,
  offGridPx,
  parseRulerLabel,
  rulerWidthPx,
  type StretchedProject,
  stretchProjectToSession,
} from "../e2e/deepZoom";
import { createRelocatedE2eProject } from "../e2e/liveProject";
import { withShareableProject } from "../e2e/shareableProject";
import { expectPaintedWaveformTile } from "../e2e/waveformHook";
import { VIEWPORT_CHUNK_PX } from "../src/utils/timelineViewport";
import {
  effectiveMaxZoomPxPerSec,
  RENDER_TILE_CSS_PX,
} from "../src/utils/timelineZoom.generated";

async function laneGeometry(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".timeline-scroll")!;
    const headerPx =
      scroller.querySelector<HTMLElement>(".track-headers")?.offsetWidth ?? 0;
    // Time-lane x of the viewport's left edge: past the border and sticky header, plus the scroll.
    const origin =
      scroller.getBoundingClientRect().left +
      scroller.clientLeft +
      headerPx -
      scroller.scrollLeft;
    const ticks = [
      ...document.querySelectorAll<HTMLElement>(".time-ruler .ruler-tick"),
    ].map((el) => {
      const r = el.getBoundingClientRect();
      const end = el.classList.contains("ruler-tick--end"); // translateX(-100%): the tick is its right edge
      return {
        label: el.textContent ?? "",
        x: (end ? r.right : r.left) - origin,
      };
    });
    const tiles = [
      ...document.querySelectorAll<HTMLCanvasElement>(
        "canvas.clip-waveform-tile",
      ),
    ].map((c) => {
      const r = c.getBoundingClientRect();
      return { x: r.left - origin, right: r.right - origin };
    });
    const point = document.querySelector(
      'circle[aria-label^="Envelope point 2 at"]',
    );
    const pr = point?.getBoundingClientRect();
    const overlay = document
      .querySelector(".envelope-overlay")
      ?.getBoundingClientRect();
    return {
      headerPx,
      scrollLeft: scroller.scrollLeft,
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
      ticks,
      tiles,
      pointX: pr ? pr.left + pr.width / 2 - origin : null,
      overlayX: overlay ? overlay.left - origin : null,
    };
  });
}

test.describe("deep zoom at the content ceiling", () => {
  test("keeps ruler, tiles, envelope and scroll range exact at 15 M px", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    let stretched!: StretchedProject;
    await withShareableProject(
      async (projectPath) => {
        await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
        await expect(page.getByRole("heading", { level: 1 })).toContainText(
          /aligned dialogue/i,
        );
        const scroll = page.locator(".timeline-scroll");
        await scroll.waitFor({ state: "visible" });
        await expectPaintedWaveformTile(page);

        const zoom = effectiveMaxZoomPxPerSec(HOUR_SEC);
        const contentPx = HOUR_SEC * zoom; // 15,000,000
        // From fit (~0.3 px/s), ×1.25 per "=" reaches the ceiling in ~43 presses.
        await scroll.click();
        for (
          let i = 0;
          i < 80 &&
          (await rulerWidthPx(page)) < contentPx - DEEP_ZOOM_TOLERANCE_PX;
          i++
        ) {
          await page.keyboard.press("=");
        }
        await expect
          .poll(() => rulerWidthPx(page))
          .toBeGreaterThanOrEqual(contentPx - DEEP_ZOOM_TOLERANCE_PX);
        await page.keyboard.press("="); // clamped: no further growth
        await expect
          .poll(() => rulerWidthPx(page))
          .toBeLessThanOrEqual(contentPx + DEEP_ZOOM_TOLERANCE_PX);

        // Scroll to the end (same pattern as large-project.spec.ts scrollToEnd).
        await scroll.evaluate((el) => {
          el.scrollLeft = el.scrollWidth;
          el.dispatchEvent(new Event("scroll"));
        });
        const lastTick = expectedLastRulerTick(HOUR_SEC, zoom);
        await expect
          .poll(async () => (await laneGeometry(page)).ticks.at(-1)?.label)
          .toBe(lastTick.label);
        const g = await laneGeometry(page);

        // Scroll range: content = header + session × zoom, and the end is reachable.
        expect(
          Math.abs(g.scrollWidth - (g.headerPx + contentPx)),
        ).toBeLessThanOrEqual(DEEP_ZOOM_TOLERANCE_PX);
        expect(g.scrollLeft + g.clientWidth).toBeGreaterThanOrEqual(
          g.scrollWidth - DEEP_ZOOM_TOLERANCE_PX,
        );

        // Ruler: the last tick is the session end (or one step before when dropped), and every tick sits at t × zoom.
        expect(HOUR_SEC - lastTick.sec).toBeLessThanOrEqual(
          lastTick.step + 1e-9,
        );
        expect(g.ticks.length).toBeGreaterThan(0);
        for (const tick of g.ticks) {
          expect(
            Math.abs(tick.x - parseRulerLabel(tick.label) * zoom),
            tick.label,
          ).toBeLessThanOrEqual(DEEP_ZOOM_TOLERANCE_PX);
        }

        // Tiles: on the 512 px grid from the clip start, and the last one ends at the session end.
        expect(g.tiles.length).toBeGreaterThan(0);
        const clipLeftPx = stretched.clipStartSec * zoom;
        for (const tile of g.tiles) {
          expect(
            offGridPx(tile.x - clipLeftPx, RENDER_TILE_CSS_PX),
          ).toBeLessThanOrEqual(DEEP_ZOOM_TOLERANCE_PX);
        }
        expect(
          Math.abs(Math.max(...g.tiles.map((t) => t.right)) - contentPx),
        ).toBeLessThanOrEqual(DEEP_ZOOM_TOLERANCE_PX);

        // Levels envelope: the point sits at t × zoom, and its chunk on the 2048 px grid.
        expect(g.pointX).not.toBeNull();
        expect(
          Math.abs(g.pointX! - stretched.endPointSec * zoom),
        ).toBeLessThanOrEqual(DEEP_ZOOM_TOLERANCE_PX);
        expect(g.overlayX).not.toBeNull();
        expect(offGridPx(g.overlayX!, VIEWPORT_CHUNK_PX)).toBeLessThanOrEqual(
          DEEP_ZOOM_TOLERANCE_PX,
        );
      },
      undefined,
      (prefix) => {
        const created = createRelocatedE2eProject(prefix);
        stretched = stretchProjectToSession(created.projectPath, HOUR_SEC);
        return created;
      },
    );
  });
});
