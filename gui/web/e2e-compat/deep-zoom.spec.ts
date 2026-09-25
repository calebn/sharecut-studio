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
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { scrollToEnd } from "../e2e/scroll";
import { withShareableProject } from "../e2e/shareableProject";
import { expectPaintedWaveformTile } from "../e2e/waveformHook";
import { VIEWPORT_CHUNK_PX } from "../src/utils/timelineViewport";
import {
  effectiveMaxZoomPxPerSec,
  RENDER_TILE_CSS_PX,
} from "../src/utils/timelineZoom.generated";

/** Scroller, ruler and one lane's geometry, as time-lane x. */
async function laneGeometry(page: Page, trackId: string) {
  return page.evaluate((trackId) => {
    const scroller = document.querySelector<HTMLElement>(".timeline-scroll")!;
    const lane = scroller.querySelector<HTMLElement>(
      `.lane-row[data-track-id="${trackId}"]`,
    );
    if (!lane) throw new Error(`No lane for track "${trackId}"`);
    const headerPx =
      scroller.querySelector<HTMLElement>(".track-headers")?.offsetWidth ?? 0;
    // Width a classic scrollbar reserves in clientWidth but the maximum scroll offset ignores (see e2e/scroll.ts).
    const gutterPx = Math.max(
      0,
      scroller.offsetWidth - scroller.clientWidth - 2 * scroller.clientLeft,
    );
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
    // Only this lane: other lanes' clips are not on this clip's tile grid.
    const tiles = [
      ...lane.querySelectorAll<HTMLCanvasElement>("canvas.clip-waveform-tile"),
    ].map((c) => {
      const r = c.getBoundingClientRect();
      return { x: r.left - origin, right: r.right - origin };
    });
    // The stretched envelope's end point: exactly one must match in the lane.
    const points = lane.querySelectorAll(
      'circle[aria-label^="Envelope point 2 at"]',
    );
    const pr =
      points.length === 1 ? points[0].getBoundingClientRect() : undefined;
    const overlay = lane
      .querySelector(".envelope-overlay")
      ?.getBoundingClientRect();
    return {
      headerPx,
      gutterPx,
      scrollLeft: scroller.scrollLeft,
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
      ticks,
      tiles,
      pointCount: points.length,
      pointX: pr ? pr.left + pr.width / 2 - origin : null,
      overlayX: overlay ? overlay.left - origin : null,
    };
  }, trackId);
}

test.describe("deep zoom at the content ceiling", () => {
  test("keeps ruler, tiles, envelope and scroll range exact at 15 M px", async ({
    page,
  }) => {
    // Covers every wait below plus setup and cleanup: switch 10 s + painted tile 30 s
    // + zoom 90 s + snapshot 60 s + restore 10 s = 200 s, before navigation.
    test.setTimeout(240_000);
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
        // From fit (~0.3 px/s), x1.25 per "=" reaches the ceiling in ~43 presses.
        // Press until the ruler reaches it: a slow layout only costs extra
        // presses, and the clamp absorbs them.
        await scroll.click();
        await expect(async () => {
          await page.keyboard.press("=");
          expect(await rulerWidthPx(page)).toBeGreaterThanOrEqual(
            contentPx - DEEP_ZOOM_TOLERANCE_PX,
          );
        }).toPass({ intervals: [50], timeout: 90_000 });
        await page.keyboard.press("="); // clamped: no further growth
        await expect
          .poll(() => rulerWidthPx(page))
          .toBeLessThanOrEqual(contentPx + DEEP_ZOOM_TOLERANCE_PX);

        // The last tick is the session end, or one step before when dropped.
        const lastTick = expectedLastRulerTick(HOUR_SEC, zoom);
        expect(HOUR_SEC - lastTick.sec).toBeLessThanOrEqual(
          lastTick.step + 1e-9,
        );
        const clipLeftPx = stretched.clipStartSec * zoom;
        // Ruler, tiles and envelope re-render at different times after the
        // scroll: re-scroll and re-read until every check holds in one snapshot.
        await expect(async () => {
          await scrollToEnd(scroll, "scrollLeft");
          const g = await laneGeometry(page, stretched.trackId);

          // Scroll range: content = header + session x zoom, and the end is reachable.
          expect(
            Math.abs(g.scrollWidth - (g.headerPx + contentPx)),
          ).toBeLessThanOrEqual(DEEP_ZOOM_TOLERANCE_PX);
          expect(
            g.scrollLeft + g.clientWidth + g.gutterPx,
          ).toBeGreaterThanOrEqual(
            g.scrollWidth - 2 * DEEP_ZOOM_TOLERANCE_PX, // rounded box vs fractional max offset
          );

          // Ruler: the expected last label, and every tick sits at t x zoom.
          expect(g.ticks.length).toBeGreaterThan(0);
          expect(g.ticks.at(-1)?.label).toBe(lastTick.label);
          for (const tick of g.ticks) {
            expect(
              Math.abs(tick.x - parseRulerLabel(tick.label) * zoom),
              tick.label,
            ).toBeLessThanOrEqual(DEEP_ZOOM_TOLERANCE_PX);
          }

          // Tiles: on the 512 px grid from the clip start, and the last one ends at the session end.
          expect(g.tiles.length).toBeGreaterThan(0);
          for (const tile of g.tiles) {
            expect(
              offGridPx(tile.x - clipLeftPx, RENDER_TILE_CSS_PX),
            ).toBeLessThanOrEqual(DEEP_ZOOM_TOLERANCE_PX);
          }
          expect(
            Math.abs(Math.max(...g.tiles.map((t) => t.right)) - contentPx),
          ).toBeLessThanOrEqual(DEEP_ZOOM_TOLERANCE_PX);

          // Levels envelope: the point sits at t x zoom, and its chunk on the 2048 px grid.
          expect(g.pointCount).toBe(1);
          expect(
            Math.abs(g.pointX! - stretched.endPointSec * zoom),
          ).toBeLessThanOrEqual(DEEP_ZOOM_TOLERANCE_PX);
          expect(g.overlayX).not.toBeNull();
          expect(offGridPx(g.overlayX!, VIEWPORT_CHUNK_PX)).toBeLessThanOrEqual(
            DEEP_ZOOM_TOLERANCE_PX,
          );
        }).toPass({ timeout: 60_000 });
      },
      undefined,
      (prefix) => {
        const created = createRelocatedE2eProject(prefix);
        try {
          stretched = stretchProjectToSession(created.projectPath, HOUR_SEC);
        } catch (error) {
          // withShareableProject's cleanup has not started yet: remove the copy here.
          removeRelocatedE2eProject(created.workspaceDir);
          throw error;
        }
        return created;
      },
    );
  });
});
