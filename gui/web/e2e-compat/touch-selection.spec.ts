import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { switchE2eProject } from "../e2e/shareableProject";
import {
  buildFixture,
  json,
  lane,
  openTimeline,
  setZoom,
  VIEWPORTS,
  type ViewportName,
} from "../e2e/touchTimeline";

/*
 * #1051 finding 1 in each engine: the timeline is a gesture surface, so its
 * text never takes a selection or the iOS callout. Browser automation cannot
 * raise the native long-press selection, so this checks the styles that stop
 * it and drags a press across clip labels the way a selection would start.
 * TOUCH_SCROLL_RUN names the run when it targets an older build.
 */

const RUN = process.env.TOUCH_SCROLL_RUN ?? "after";

test.use({ hasTouch: true });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-touch-select-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

test("timeline text takes no selection or callout", async ({
  page,
  browserName,
}, info) => {
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, "e2e-touch-select");
  const rows: Record<string, unknown>[] = [];
  for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
    await openTimeline(page, projectPath, viewport, "dark");
    await setZoom(page, 3);
    const label = page.locator(`${lane} .clip-label`).first();
    await label.scrollIntoViewIfNeeded();
    const style = await label.evaluate((el) => {
      const s = getComputedStyle(el);
      // The rule as this engine parsed it: an engine without a touch callout
      // (desktop) drops that declaration.
      const rule = [...document.styleSheets]
        .flatMap((sheet) => [...sheet.cssRules])
        .find(
          (r) =>
            r instanceof CSSStyleRule &&
            r.selectorText === ".timeline-hit-root",
        );
      return {
        userSelect:
          s.getPropertyValue("-webkit-user-select") ||
          s.getPropertyValue("user-select"),
        touchCallout:
          s.getPropertyValue("-webkit-touch-callout") || "(not exposed)",
        rule: rule?.cssText ?? null,
      };
    });
    // A press that starts in the lane gap above the label and drags across
    // it, the way a text selection starts.
    const box = (await label.boundingBox())!;
    await page.evaluate(() => document.getSelection()?.removeAllRanges());
    await page.mouse.move(box.x + 2, box.y - 4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width, box.y + box.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    rows.push({
      browserName,
      viewport,
      style,
      selection: await page.evaluate(
        () => document.getSelection()?.toString() ?? "",
      ),
    });
  }
  json(info, `selection-${browserName}-${RUN}`, rows);
  for (const row of rows) {
    expect(row).toMatchObject({ style: { userSelect: "none" }, selection: "" });
  }
});
