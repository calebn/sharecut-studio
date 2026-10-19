import { expect, type Page, test } from "@playwright/test";
import { LONG_PRESS_MS } from "../src/hooks/gestureConstants";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { switchE2eProject } from "./shareableProject";
import {
  newTouchPage,
  type Point,
  touch,
  VIEWPORTS,
  type ViewportName,
} from "./touchTimeline";

/*
 * Timeline comment pins on touch (#1742): a pin is --touch-min wide around its
 * dot while its row stays one marker row tall, pins on one spot fan out through
 * the touch chooser, and a finger beside a pin picks it without taking the
 * ruler's or a clip's taps.
 */

const CLIENT_ID = "e2e-comment-pins-touch";
const HOLD_MS = LONG_PRESS_MS + 150;
const TOUCH_MIN = 44;
const MARKER_ROW = 24;
const STACKED = ["Ada", "Ben", "Cy"] as const;

test.use({ hasTouch: true, isMobile: true });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-comment-pins-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async ({ page }) => {
  await page.close();
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

async function addComments(page: Page): Promise<void> {
  const add = (author: string, timeline_start: number) =>
    postDocumentCommand(
      page,
      CLIENT_ID,
      "AddComment",
      { body: `${author} at ${timeline_start}`, author, timeline_start },
      projectPath,
    );
  for (const author of STACKED) await add(author, 5);
  await add("Dee", 12);
  await add("Eli", 30);
}

async function openTimeline(page: Page, viewport: ViewportName): Promise<void> {
  await page.setViewportSize(VIEWPORTS[viewport]);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  if (viewport === "phone") await openPhoneTimeline(page);
  await expect(page.locator(".comment-marker.pin")).toHaveCount(5);
}

const pin = (page: Page, author: string) =>
  page.locator(`.comment-marker.pin[aria-label="Comment by ${author}"]`);

async function centre(page: Page, author: string): Promise<Point> {
  const box = await pin(page, author).boundingBox();
  if (!box) throw new Error(`pin ${author} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const selectedPins = (page: Page) =>
  page
    .locator(".comment-marker.selected")
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));

async function tap(
  page: Page,
  cdp: Awaited<ReturnType<typeof newTouchPage>>["cdp"],
  at: Point,
) {
  await touch(cdp, "touchStart", [at]);
  await page.waitForTimeout(60);
  await touch(cdp, "touchEnd");
  await page.waitForTimeout(400);
}

for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
  test(`${viewport}: a pin is ${TOUCH_MIN} px wide and the row keeps its height`, async ({
    page,
  }) => {
    await page.goto("/");
    await addComments(page);
    await openTimeline(page, viewport);
    for (const author of ["Dee", "Eli"]) {
      const box = await pin(page, author).boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(TOUCH_MIN - 0.5);
      expect(box?.height).toBe(MARKER_ROW);
    }
  });
}

test("a tap beside a pin picks it, and a tap on a clip under the lane never does", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await addComments(page);
  const { page: p, cdp } = await newTouchPage(context);
  await openTimeline(p, "phone");
  const dee = await centre(p, "Dee");
  await tap(p, cdp, { x: dee.x + 18, y: dee.y });
  expect(await selectedPins(p)).toEqual(["Comment by Dee"]);
  await tap(p, cdp, { x: dee.x - 18, y: dee.y });
  expect(await selectedPins(p)).toEqual(["Comment by Dee"]);

  const lane = (await p.locator(".marker-lane").boundingBox())!;
  const clip = (await p
    .locator('[data-hit-kind="clip"]')
    .first()
    .boundingBox())!;
  await tap(p, cdp, {
    x: dee.x,
    y: Math.max(clip.y, lane.y + lane.height) + 8,
  });
  expect(await selectedPins(p)).toEqual([]);
  await p.close();
});

test("pins on one spot count themselves and the chooser picks each comment", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await addComments(page);
  const { page: p, cdp } = await newTouchPage(context);
  await openTimeline(p, "phone");
  await expect(pin(p, "Ada")).toHaveAttribute("data-stack-count", "3");
  await expect(pin(p, "Dee")).not.toHaveAttribute("data-stack-count", /.+/);

  const at = await centre(p, "Ada");
  // Against the stack's order, so a pick that cycled would land on the wrong pin.
  for (const author of [...STACKED].reverse()) {
    await touch(cdp, "touchStart", [at]);
    await p.waitForTimeout(HOLD_MS);
    const chip = p.getByRole("menuitemradio", {
      name: `Comment by ${author} at 00:05.000`,
    });
    await expect(chip).toBeVisible();
    await touch(cdp, "touchEnd");
    await p.waitForTimeout(250);
    const box = (await chip.boundingBox())!;
    await touch(cdp, "touchStart", [
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    ]);
    await touch(cdp, "touchEnd");
    await expect(p.locator(".target-chooser:not(.is-closing)")).toHaveCount(0);
    await p.waitForTimeout(300);
    expect(await selectedPins(p)).toEqual([`Comment by ${author}`]);
  }
  await p.close();
});
