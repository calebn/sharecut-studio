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

async function expectComment(page: Page, author: string, at: number) {
  const selected = page
    .getByRole("main", { name: "Review" })
    .locator('.sys-decision[data-kind="comment"]');
  await expect(selected).toHaveCount(1);
  await expect(selected).toBeVisible();
  await expect(
    selected.getByRole("heading", {
      name: `Comment from ${author}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(selected.locator(".sys-comment-author")).toHaveText(author);
  await expect(selected.locator(".sys-comment-body")).toHaveText(
    `${author} at ${at}`,
  );
  await expect(
    selected.getByRole("textbox", { name: `Reply to ${author}`, exact: true }),
  ).toBeVisible();
}

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
    const geometry = await page
      .locator(".sys-markers .sys-marker-hit")
      .evaluateAll((elements) => {
        const identity = (node: Element | null) =>
          node
            ? {
                tag: node.tagName,
                class: node.getAttribute("class"),
                label: node.getAttribute("aria-label"),
                id: node.getAttribute("data-hit-id"),
                kind: node.closest(".sys-marker")?.getAttribute("data-kind"),
                rect: node.getBoundingClientRect().toJSON(),
                html: node.outerHTML.slice(0, 1200),
              }
            : null;
        return elements.map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const after = getComputedStyle(element, "::after");
          const left = Number.parseFloat(after.left);
          const right = Number.parseFloat(after.right);
          const top = Number.parseFloat(after.top);
          const bottom = Number.parseFloat(after.bottom);
          const border = {
            left: Number.parseFloat(style.borderLeftWidth),
            right: Number.parseFloat(style.borderRightWidth),
            top: Number.parseFloat(style.borderTopWidth),
            bottom: Number.parseFloat(style.borderBottomWidth),
          };
          const paddingBox = {
            left: rect.left + border.left,
            right: rect.right - border.right,
            top: rect.top + border.top,
            bottom: rect.bottom - border.bottom,
          };
          const interval = {
            left: paddingBox.left + left,
            right: paddingBox.right - right,
          };
          const pseudoBounds = {
            ...interval,
            top: paddingBox.top + top,
            bottom: paddingBox.bottom - bottom,
          };
          const centerX = (interval.left + interval.right) / 2;
          const centerY = (pseudoBounds.top + pseudoBounds.bottom) / 2;
          const point = (x: number, y: number) => {
            const node = document.elementFromPoint(x, y);
            return {
              x,
              y,
              owned: element.contains(node),
              node: identity(node),
            };
          };
          const ancestors = [];
          for (
            let node = element.parentElement;
            node && ancestors.length < 6;
            node = node.parentElement
          ) {
            const style = getComputedStyle(node);
            ancestors.push({
              node: identity(node),
              overflowX: style.overflowX,
              overflowY: style.overflowY,
            });
          }
          return {
            label: element.getAttribute("aria-label"),
            rect: rect.toJSON(),
            row: element
              .closest(".sys-markers")
              ?.getBoundingClientRect()
              .toJSON(),
            devicePixelRatio,
            ancestors,
            border,
            paddingBox,
            pseudoBounds,
            after: {
              content: after.content,
              display: after.display,
              top: after.top,
              bottom: after.bottom,
              left: after.left,
              right: after.right,
            },
            height: rect.height,
            pseudo:
              after.content !== "none" &&
              after.content !== "normal" &&
              after.display !== "none",
            finiteInsets: [
              left,
              right,
              top,
              bottom,
              ...Object.values(border),
            ].every(Number.isFinite),
            effectiveWidth: interval.right - interval.left,
            interval,
            allocated: [
              point(interval.left + 0.5, centerY),
              point(interval.right - 0.5, centerY),
            ],
            outsideAllocated: [
              point(interval.left - 1, centerY),
              point(interval.right + 1, centerY),
            ],
            horizontal: [-21.5, 21.5].map((offset) =>
              point(centerX + offset, centerY),
            ),
            boundaries: [0.25, 0.5, 0.75, 1, 2].map((offset) => ({
              offset,
              above: point(centerX, rect.top - offset),
              below: point(centerX, rect.bottom + offset),
            })),
          };
        });
      });
    const geometryFile = path.join(
      "playwright-report",
      `issue-2964-comment-target-geometry-${viewport}-retry${info.retry}.json`,
    );
    fs.mkdirSync(path.dirname(geometryFile), { recursive: true });
    fs.writeFileSync(geometryFile, `${JSON.stringify(geometry, null, 2)}\n`);
    await info.attach(`comment-target-geometry-${viewport}`, {
      path: geometryFile,
      contentType: "application/json",
    });
    expect((await page.locator(".sys-markers").boundingBox())?.height).toBe(
      MARKER_ROW,
    );
    for (const author of ["Dee", "Eli"]) {
      const target = geometry.find((item) =>
        item.label?.startsWith(`Comment by ${author},`),
      )!;
      expect(target.height).toBe(MARKER_ROW);
      expect(target.pseudo).toBe(true);
      expect(target.finiteInsets).toBe(true);
      expect(target.rect.top).toBe(target.row.top);
      expect(target.rect.bottom).toBe(target.row.bottom);
      expect(target.row.height).toBe(MARKER_ROW);
      expect(Number.parseFloat(target.after.top)).toBe(0);
      expect(Number.parseFloat(target.after.bottom)).toBe(0);
      const track = target.ancestors.find((ancestor) =>
        ancestor.node?.class?.split(" ").includes("sys-markers-track"),
      )!;
      expect(track.overflowX).toBe("clip");
      expect(track.overflowY).toBe("clip");
      expect(track.node!.rect.top).toBe(target.row.top);
      expect(track.node!.rect.bottom).toBe(target.row.bottom);
      expect(target.allocated.map((point) => point.owned)).toEqual([
        true,
        true,
      ]);
      if (author === "Dee" && viewport === "phone") {
        const stack = geometry.find((item) => item.label === "2 more markers")!;
        const logicalStackWidth = 40;
        const logicalStackRight = stack.rect.left + logicalStackWidth;
        const logicalGap = target.rect.left - logicalStackRight;
        const renderedGap = target.rect.left - stack.rect.right;
        expect(target.rect.width).toBe(16);
        expect(stack.rect.width).toBe(32);
        expect(renderedGap).toBe(26);
        expect(logicalGap).toBe(18);
        expect(Number.parseFloat(target.after.left)).toBe(-9);
        expect(Number.parseFloat(target.after.right)).toBe(-14);
        expect(target.effectiveWidth).toBe(39);
        expect(target.rect.left - target.interval.left).toBe(logicalGap / 2);
        expect(Number.parseFloat(stack.after.right)).toBe(-logicalGap / 2);
        expect(stack.border).toEqual({ left: 1, right: 1, top: 1, bottom: 1 });
        expect(stack.effectiveWidth).toBe(logicalStackWidth);
        expect(stack.interval.right).toBe(logicalStackRight);
        expect(stack.interval.right).toBeLessThanOrEqual(target.interval.left);
        expect(target.interval.right).toBeLessThanOrEqual(
          geometry.find((item) => item.label?.startsWith("Comment by Eli,"))!
            .interval.left,
        );
        expect(stack.allocated.map((point) => point.owned)).toEqual([
          true,
          true,
        ]);
        expect(stack.outsideAllocated[1].owned).toBe(false);
      } else {
        expect(target.effectiveWidth).toBeGreaterThanOrEqual(44);
        expect(target.horizontal.map((point) => point.owned)).toEqual([
          true,
          true,
        ]);
      }
      for (const offset of [1, 2]) {
        const boundary = target.boundaries.find(
          (point) => point.offset === offset,
        )!;
        expect([boundary.above.owned, boundary.below.owned]).toEqual([
          false,
          false,
        ]);
        expect(boundary.above.node?.class?.split(" ")).toContain(
          "sys-ruler-body",
        );
        expect(boundary.below.node?.class?.split(" ")).toContain("lane-seek");
      }
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

for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
  test(`${viewport}: the dense marker has an exact Review list equivalent`, async ({
    page,
  }) => {
    await page.goto("/");
    await addComments(page);
    await openTimeline(page, viewport);
    await stageTab(page, "review").click();
    if (viewport === "phone")
      await page.locator(".rv-phone-top button").click();
    const row = page
      .locator('.sys-queue-row[data-kind="comment"]')
      .filter({ hasText: "Dee at 20" });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".sys-queue-snippet")).toHaveText("Dee at 20");
    const control = row.locator(".sys-queue-main");
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await control.click();
    await expectComment(page, "Dee", 20);
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
    await expectComment(p, author, 5);
    await expect(p.getByRole("menuitem")).toHaveCount(0);
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
