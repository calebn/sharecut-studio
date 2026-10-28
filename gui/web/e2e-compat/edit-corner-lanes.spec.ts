import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { switchE2eProject } from "../e2e/shareableProject";
import { openProject } from "../e2e/stageNav";
import { buildFixture, json } from "../e2e/touchTimeline";

test.use({ hasTouch: true });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-edit-corner-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  removeRelocatedE2eProject(workspaceDir);
});

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LaneOverlap {
  track: string | null;
  overlapPx: number;
}

async function cornerOverLanes(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const area = (a: Box, b: Box) =>
      Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
      Math.max(
        0,
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
      );
    const scroll = document.querySelector(".timeline-scroll");
    const corner = document.querySelector(".edit-workspace .edit-corner");
    const cornerBox = corner ? box(corner) : null;
    const shown = cornerBox !== null && cornerBox.width * cornerBox.height > 0;
    const scrollBox = scroll ? box(scroll) : null;
    const lanes: LaneOverlap[] = [
      ...document.querySelectorAll(".lane-row"),
    ].map((lane) => {
      const laneBox = box(lane);
      const visible = scrollBox
        ? {
            ...laneBox,
            y: Math.max(laneBox.y, scrollBox.y),
            height:
              Math.min(
                laneBox.y + laneBox.height,
                scrollBox.y + scrollBox.height,
              ) - Math.max(laneBox.y, scrollBox.y),
          }
        : laneBox;
      return {
        track: lane.getAttribute("data-track-id"),
        overlapPx: shown && cornerBox ? area(cornerBox, visible) : 0,
      };
    });
    return { shown, corner: cornerBox, lanes };
  });
}

async function hitsItself(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(
      r.x + r.width / 2,
      r.y + r.height / 2,
    );
    return !!top && (top === el || el.contains(top));
  });
}

test("the Edit corner covers no lane at 844x390, and every guest M and S is hit-testable", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, "e2e-edit-corner");
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame--tablet")).toBeVisible();
  await expect(
    page.locator('.timeline-scroll .track-headers:not([aria-busy="true"])'),
  ).toBeVisible();
  await expect(page.locator(".lane-row").nth(1)).toBeVisible();
  const measured = await cornerOverLanes(page);
  json(info, "edit-corner-over-lanes", measured);
  expect(measured.lanes.length).toBeGreaterThanOrEqual(2);
  expect(measured.lanes.filter((lane) => lane.overlapPx > 0)).toEqual([]);
  expect(await hitsItself(page, "Mute guest")).toBe(true);
  expect(await hitsItself(page, "Solo guest")).toBe(true);
});
