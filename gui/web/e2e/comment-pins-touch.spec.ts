import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { switchE2eProject } from "./shareableProject";
import { openProject, stageTab } from "./stageNav";
import {
  newTouchPage,
  type Point,
  touch,
  VIEWPORTS,
  type ViewportName,
} from "./touchTimeline";

const CLIENT_ID = "e2e-comment-pins-touch";
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
  await add("Dee", 20);
  await add("Eli", 30);
}

async function openTimeline(page: Page, viewport: ViewportName): Promise<void> {
  await page.setViewportSize(VIEWPORTS[viewport]);
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame")).toBeVisible();
  if (viewport === "phone") await openPhoneTimeline(page);
  await expect(pinHits(page)).toHaveCount(3);
}

const pinHits = (page: Page) =>
  page.locator('.sys-marker[data-kind="comment"] .sys-marker-hit');
const pin = (page: Page, author: string) =>
  page.getByRole("button", { name: new RegExp(`^Comment by ${author},`) });

async function centre(page: Page, author: string): Promise<Point> {
  const box = await pin(page, author).boundingBox();
  if (!box) throw new Error(`pin ${author} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Where a pin is once the layout (the inspector opening shifts it) holds still. */
async function settledCentre(page: Page, author: string): Promise<Point> {
  let last = "";
  await expect
    .poll(async () => {
      const now = JSON.stringify(await centre(page, author));
      const still = now === last;
      last = now;
      return still;
    })
    .toBe(true);
  return centre(page, author);
}

// Choosing a pin also opens its comment in Review; the pin's own state is read
// back on the Edit stage, where the timeline is.
const selectedPins = async (page: Page) => {
  // No wait on the tab: the app may be moving to Review as this runs, and the
  // poll reading it simply tries again.
  const edit = stageTab(page, "edit");
  if ((await edit.getAttribute("aria-selected")) !== "true") await edit.click();
  return pinHits(page).evaluateAll((els) =>
    els
      .filter((el) => el.getAttribute("aria-pressed") === "true")
      .map(
        (el) =>
          /^Comment by (\w+),/.exec(el.getAttribute("aria-label") ?? "")?.[1],
      ),
  );
};

async function tap(
  cdp: Awaited<ReturnType<typeof newTouchPage>>["cdp"],
  at: Point,
) {
  await touch(cdp, "touchStart", [at]);
  await touch(cdp, "touchEnd");
}

for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
  test(`${viewport}: the lane keeps its height and a pin's hit area spans it`, async ({
    page,
  }, info) => {
    await page.goto("/");
    await addComments(page);
    await openTimeline(page, viewport);
    expect((await page.locator(".sys-markers").boundingBox())?.height).toBe(
      MARKER_ROW,
    );
    for (const author of ["Dee", "Eli"]) {
      const box = (await pin(page, author).boundingBox())!;
      expect(box.height).toBe(MARKER_ROW);
      expect(box.width).toBeGreaterThanOrEqual(44);
      const ownership = await pin(page, author).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return [-18, 18].map((offset) =>
          element.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2 + offset,
              rect.y + rect.height / 2,
            ),
          ),
        );
      });
      expect(ownership).toEqual([true, true]);
    }
    const file = path.join(
      "playwright-report",
      `issue-2964-comment-targets-${viewport}.png`,
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file });
    await info.attach(`comment-targets-${viewport}`, {
      path: file,
      contentType: "image/png",
    });
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
  const dee = await settledCentre(p, "Dee");
  await tap(cdp, { x: dee.x + 18, y: dee.y });
  await expect.poll(() => selectedPins(p)).toEqual(["Dee"]);
  const settled = await settledCentre(p, "Dee");

  const lane = (await p.locator(".marker-lane").boundingBox())!;
  const clip = (await p
    .locator('[data-hit-kind="clip"]')
    .first()
    .boundingBox())!;
  await tap(cdp, {
    x: settled.x,
    y: Math.max(clip.y, lane.y + lane.height) + 8,
  });
  // Dee was selected: only a tap that reached the clip clears her.
  await expect.poll(() => selectedPins(p)).toEqual([]);
  await p.close();
});

test("pins on one spot fold into a +2 chip and its list picks each comment", async ({
  page,
  context,
}, info) => {
  await page.goto("/");
  await addComments(page);
  const { page: p, cdp } = await newTouchPage(context);
  await openTimeline(p, "phone");
  const chip = p.getByRole("button", { name: "2 more markers" });
  await expect(chip).toBeVisible();

  const shown = await pinHits(p).evaluateAll((els) =>
    els.map(
      (el) =>
        /^Comment by (\w+),/.exec(el.getAttribute("aria-label") ?? "")?.[1],
    ),
  );
  const hidden = STACKED.filter((author) => !shown.includes(author));
  expect(hidden).toHaveLength(2);
  for (const author of hidden) {
    const box = (await chip.boundingBox())!;
    await tap(cdp, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const item = p.getByRole("menuitem", {
      name: new RegExp(`^Comment by ${author},`),
    });
    await expect(item).toBeVisible();
    let last = "";
    await expect
      .poll(async () => {
        const now = JSON.stringify(await item.boundingBox());
        const still = now === last;
        last = now;
        return still;
      })
      .toBe(true);
    const at = (await item.boundingBox())!;
    await tap(cdp, { x: at.x + at.width / 2, y: at.y + at.height / 2 });
    await expect(stageTab(p, "review")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const selected = p.locator(
      '.sys-queue-row[data-kind="comment"][data-selected="true"]',
    );
    await expect(selected).toHaveCount(1);
    await expect(selected).toContainText(`${author} at 5`);
    const file = path.join(
      "playwright-report",
      `issue-2964-hidden-comment-${author}.png`,
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await p.screenshot({ path: file });
    await info.attach(`hidden-comment-${author}`, {
      path: file,
      contentType: "image/png",
    });
    await stageTab(p, "edit").click();
    await expect(p.getByRole("menuitem")).toHaveCount(0);
  }
  await p.close();
});

test.describe("with a mouse", () => {
  test.use({ hasTouch: false, isMobile: false });

  test("a click selects one pin and Tab with Enter opens exactly one", async ({
    page,
  }) => {
    await page.goto("/");
    await addComments(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openProject(page, projectPath);
    await expect(pinHits(page)).toHaveCount(3);
    const box = (await pin(page, "Dee").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => selectedPins(page)).toEqual(["Dee"]);
    await pin(page, "Eli").focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => selectedPins(page)).toEqual(["Eli"]);
  });
});
