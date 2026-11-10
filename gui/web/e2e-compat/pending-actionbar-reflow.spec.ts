import { expect, type Locator, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "../e2e/documentCommand";
import { e2eProjectPath } from "../e2e/env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import {
  type Box,
  chromeBoxes,
  expectHitTestable,
  isHitTestable,
  settle,
  suggestOnFirstDialogueTrack,
} from "../e2e/pendingActionbar";
import { switchE2eProject } from "../e2e/shareableProject";
import { inspectSelectionByKey, openProject } from "../e2e/stageNav";

const CLIENT_ID = "e2e-actionbar-reflow";
const REFINE_GATE =
  "Transcript refine is required before focus/tighten/NL edits. Run podcast-transcript-refine (whole-episode pass), then `podcast transcript refine-waive --reason ...` / transcript_refine_waive_tool.";
let projectPath: string;
let workspaceDir: string;

const INSPECTOR_SCROLL = ".sys-inspector-scroll";

interface Point {
  x: number;
  y: number;
}

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-actionbar-reflow-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});
test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

async function openWithSuggestion(page: Page): Promise<void> {
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame")).toBeVisible();
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "AddChapter",
    { time: 15, title: "Reflow chapter" },
    projectPath,
  );
  await suggestOnFirstDialogueTrack(page, projectPath, CLIENT_ID);
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame")).toBeVisible();
  await page
    .locator("[data-pending-id]")
    .last()
    .click({ position: { x: 4, y: 4 } });
  await expect(page.locator(".pending-actionbar")).toBeVisible();
}

async function boxOf(locator: Locator): Promise<Box> {
  return locator.evaluate((el) => {
    const { top, bottom } = el.getBoundingClientRect();
    return { top, bottom };
  });
}

async function cardTop(page: Page): Promise<number> {
  return (await boxOf(page.locator(".pending-actionbar"))).top;
}

async function wheelInspectorToward(page: Page, button: Locator) {
  const attempt = await button.evaluateHandle((target, scrollSelector) => {
    const body = target.closest(scrollSelector);
    const timeline = document.querySelector(".timeline-scroll");
    if (!(body instanceof HTMLElement) || !timeline)
      throw new Error("Missing Inspector body or timeline");

    const controller = new AbortController();
    const describe = (element: Element | null) =>
      element && {
        tag: element.tagName,
        id: element.id,
        classes: element.getAttribute("class"),
      };
    let delivery: {
      point: Point;
      receiver: ReturnType<typeof describe>;
      owned: boolean;
      trusted: boolean;
    } | null = null;
    const timelinePosition = () => ({
      x: timeline.scrollLeft,
      y: timeline.scrollTop,
    });
    let scrollBefore = body.scrollTop;
    let timelineBefore = timelinePosition();
    const bounds = (element: Element) => {
      const { left, top, right, bottom, width, height } =
        element.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    const hitAt = ({ x, y }: Point) => document.elementFromPoint(x, y);
    const geometry = () => {
      const rect = bounds(body);
      const card = body.closest(".sys-inspector--card");
      return {
        body: rect,
        card: card && bounds(card),
        clientHeight: body.clientHeight,
        scrollHeight: body.scrollHeight,
        viewport: { width: innerWidth, height: innerHeight },
        interior: {
          left: Math.max(0, rect.left),
          right: Math.min(innerWidth, rect.right),
          top: Math.max(0, rect.top),
          bottom: Math.min(innerHeight, rect.bottom),
        },
      };
    };

    return {
      aim() {
        const layout = geometry();
        const { left, right, top, bottom } = layout.interior;
        const samples = [];
        const fractions = [0.5, 0.1, 0.9];
        for (const fy of fractions) {
          for (const fx of fractions) {
            const point = {
              x: Math.round(left + (right - left) * fx),
              y: Math.round(top + (bottom - top) * fy),
            };
            if (
              point.x <= left ||
              point.x >= right ||
              point.y <= top ||
              point.y >= bottom
            )
              continue;
            const hit = hitAt(point);
            if (hit && body.contains(hit)) return { point, layout, samples };
            samples.push({ point, receiver: describe(hit) });
          }
        }
        return { point: null, layout, samples };
      },
      arm(point: Point) {
        const layout = geometry();
        const hit = hitAt(point);
        const { left, right, top, bottom } = layout.interior;
        const inside =
          point.x > left &&
          point.x < right &&
          point.y > top &&
          point.y < bottom;
        if (!inside || !hit || !body.contains(hit) || !body.contains(target)) {
          return { deltaY: null, point, receiver: describe(hit), layout };
        }

        delivery = null;
        scrollBefore = body.scrollTop;
        timelineBefore = timelinePosition();
        body.addEventListener(
          "wheel",
          (event) => {
            const hit = event.target instanceof Element ? event.target : null;
            delivery = {
              point: { x: event.clientX, y: event.clientY },
              receiver: describe(hit),
              owned: hit !== null && body.contains(hit),
              trusted: event.isTrusted,
            };
          },
          {
            capture: true,
            once: true,
            passive: true,
            signal: controller.signal,
          },
        );

        const rect = bounds(target);
        const distance = rect.top + rect.height / 2 - (top + bottom) / 2;
        const deltaY =
          (distance < 0 ? -1 : 1) *
          Math.max(1, Math.min(120, Math.abs(distance)));
        return { deltaY, point, receiver: describe(hit), layout };
      },
      read(current: Element, point: Point) {
        const rect = bounds(current);
        const hit = hitAt({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
        const buttonHit = hit !== null && current.contains(hit);
        const scrollAfter = body.scrollTop;
        const timelineAfter = timelinePosition();
        return {
          delivery,
          currentBody: body.isConnected && body.contains(current),
          layout: geometry(),
          pointerReceiver: describe(hitAt(point)),
          button: {
            rect,
            receiver: describe(hit),
            hit: buttonHit,
          },
          scrollBefore,
          scrollAfter,
          timelineBefore,
          timelineAfter,
          progressed: scrollAfter !== scrollBefore || buttonHit,
        };
      },
      abort: () => controller.abort(),
    };
  }, INSPECTOR_SCROLL);

  try {
    let input: { point: Point; deltaY: number } | undefined;
    await expect
      .poll(
        async () => {
          const aim = await attempt.evaluate((state) => state.aim());
          if (!aim.point) return aim;
          await page.mouse.move(aim.point.x, aim.point.y);
          const armed = await attempt.evaluate(
            (state, point) => state.arm(point),
            aim.point,
          );
          if (armed.deltaY === null) return armed;
          input = { point: armed.point, deltaY: armed.deltaY };
          return null;
        },
        {
          message:
            "A sampled point in the visible Inspector body must still belong to it after moving the pointer",
        },
      )
      .toBeNull();

    if (!input) throw new Error("Inspector wheel input was not armed");
    const { point, deltaY } = input;
    await page.mouse.wheel(0, deltaY);
    const readReceipt = () =>
      button.evaluate(
        (current, { attempt, point }) => attempt.read(current, point),
        { attempt, point },
      );
    let receipt: Awaited<ReturnType<typeof readReceipt>> | undefined;
    await expect
      .poll(
        async () => {
          receipt = await readReceipt();
          const delivery = receipt.delivery;
          return receipt.currentBody &&
            receipt.progressed &&
            delivery?.trusted &&
            delivery.owned &&
            delivery.point.x === point.x &&
            delivery.point.y === point.y
            ? null
            : receipt;
        },
        {
          message:
            "The current Inspector body must receive this wheel and scroll or expose the intended button",
        },
      )
      .toBeNull();
    if (!receipt) throw new Error("Inspector wheel receipt was not recorded");
    expect(receipt.timelineAfter, JSON.stringify(receipt)).toEqual(
      receipt.timelineBefore,
    );
    return receipt;
  } finally {
    await attempt.evaluate((state) => state.abort());
    await attempt.dispose();
  }
}

test("pending card: a marker added while it floats leaves the one-row lane where it was and the card clear of it", async ({
  page,
}) => {
  test.setTimeout(40_000);
  await page.setViewportSize({ width: 1280, height: 540 });
  await openWithSuggestion(page);
  await settle(page);
  const before = await chromeBoxes(page);
  expect(await cardTop(page)).toBeGreaterThanOrEqual(
    Math.max(before.ruler.bottom, before.marker.bottom) - 0.5,
  );

  await postDocumentCommand(
    page,
    CLIENT_ID,
    "AddComment",
    {
      body: "Marker lane grows",
      author: "Playwright",
      timeline_start: 25,
      timeline_end: 28,
    },
    projectPath,
  );
  await expect(
    page.locator('.sys-marker[data-kind="comment"]').first(),
  ).toBeVisible();
  expect((await chromeBoxes(page)).marker.bottom).toBeCloseTo(
    before.marker.bottom,
    0,
  );

  await expect
    .poll(async () => {
      const { ruler, marker } = await chromeBoxes(page);
      const card = await boxOf(page.locator(".pending-actionbar"));
      const region = await boxOf(page.locator(".pending-overlay.selected"));
      return {
        belowChrome: card.top >= Math.max(ruler.bottom, marker.bottom) - 0.5,
        clearOfRegion:
          card.top >= region.bottom - 0.5 || card.bottom <= region.top + 0.5,
      };
    })
    .toEqual({ belowChrome: true, clearOfRegion: true });
});

test("pending review: inline Approve and Reject stay reachable after 720 to 360 to 260", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.route("**/api/document/command**", async (route) => {
    const body: unknown = route.request().postDataJSON();
    if (
      body &&
      typeof body === "object" &&
      "type" in body &&
      body.type === "ApproveEdits"
    ) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        headers: { "X-Sharecut-Error-Code": "transcript_refine_required" },
        body: JSON.stringify({ detail: REFINE_GATE }),
      });
      return;
    }
    await route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await openWithSuggestion(page);
  await page
    .locator(".pending-actionbar")
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  const refusal = page.getByRole("alert").first();
  await expect(refusal).toBeVisible();
  await expect(refusal).toHaveText(
    "The transcript isn't checked yet. Cut anyway, or check it first.",
  );
  await expect(
    page
      .locator(".pending-actionbar")
      .getByRole("button", { name: "Cut anyway", exact: true }),
  ).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 360 });
  await settle(page);
  const floating = page.locator(".pending-actionbar");
  await expect(floating).toBeVisible();
  await expectHitTestable(
    floating.getByRole("button", { name: "Approve", exact: true }),
  );
  await expectHitTestable(
    floating.getByRole("button", { name: "Reject", exact: true }),
  );

  await page.setViewportSize({ width: 1280, height: 260 });
  await settle(page);
  await inspectSelectionByKey(page);

  const inspector = page
    .locator(
      '[role="dialog"].sys-inspector--card, [role="dialog"]:has(.sys-inspector-takeover)',
    )
    .locator(INSPECTOR_SCROLL)
    .filter({ has: page.locator(".modifier-inspector") });
  await expect(inspector).toBeAttached();
  for (const name of ["Approve", "Reject"]) {
    const button = inspector.getByRole("button", { name, exact: true });
    let receipt: Awaited<ReturnType<typeof wheelInspectorToward>> | undefined;
    for (let step = 0; step < 20 && !(await isHitTestable(button)); step++) {
      receipt = await wheelInspectorToward(page, button);
    }
    await expect(button).toBeVisible();
    expect(
      await isHitTestable(button),
      `${name} must receive a pointer at its center. Last wheel receipt: ${JSON.stringify(receipt)}`,
    ).toBe(true);
  }
  expect(
    await page.locator(".stage-frame").evaluate((el) => el.scrollTop),
    "the shell itself never scrolls",
  ).toBe(0);
});
