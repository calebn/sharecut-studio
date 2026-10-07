import { expect, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { openSuggestedPendingEdit } from "./pendingEdit";
import { openPhoneTimeline } from "./phoneTimeline";
import { switchE2eProject } from "./shareableProject";

const CLIENT_ID = "e2e-pending-edge-controls";
const MIN_COARSE_HANDLE_LANE_HEIGHT = 88;

test.use({ hasTouch: true, isMobile: true });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject(
    "sharecut-e2e-pending-edge-controls-",
  );
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async ({ page }) => {
  await page.close();
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

test("phone pending controls stay clear of handles and dense labels follow layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openSuggestedPendingEdit(page, projectPath);
  const trackId = await page.evaluate(async (projectPath) => {
    const response = await fetch(
      `/api/project?path=${encodeURIComponent(projectPath)}&phase=shell`,
    );
    const project = (await response.json()) as {
      tracks: { id: string; role?: string }[];
    };
    return project.tracks.find((track) => track.role === "dialogue")?.id;
  }, projectPath);
  expect(trackId).toBeTruthy();
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "SuggestPendingEdit",
    {
      track_id: trackId,
      start: 4,
      end: 4.8,
      reason: "guest:suggest",
    },
    projectPath,
  );
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "SuggestPendingEdit",
    {
      track_id: trackId,
      start: 6,
      end: 6.8,
      reason: "guest:suggest",
    },
    projectPath,
  );
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "SuggestPendingEdit",
    {
      track_id: trackId,
      start: 20,
      end: 28,
      reason: "guest:suggest",
    },
    projectPath,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await openPhoneTimeline(page);
  const laneHeight = page.locator(".timeline-area");
  const currentLaneHeight = () =>
    laneHeight.evaluate((element) =>
      Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--lane-height"),
      ),
    );
  for (
    let attempt = 0;
    attempt < 4 && (await currentLaneHeight()) < MIN_COARSE_HANDLE_LANE_HEIGHT;
    attempt += 1
  ) {
    await page.getByRole("button", { name: "Menu" }).click();
    await page
      .getByRole("menu", { name: "Transport menu" })
      .getByRole("menuitem", { name: "Track height +" })
      .click();
  }
  expect(await currentLaneHeight()).toBeGreaterThanOrEqual(
    MIN_COARSE_HANDLE_LANE_HEIGHT,
  );
  const scroll = page.locator(".timeline-scroll");
  const scrollWidthBeforeEndEdit = await scroll.evaluate(
    (node) => node.scrollWidth,
  );
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "SuggestPendingEdit",
    {
      track_id: trackId,
      start: 59.9,
      end: 60,
      reason: "guest:suggest",
    },
    projectPath,
  );

  const regions = page.locator(".pending-overlay");
  await expect(regions).toHaveCount(5);
  await expect
    .poll(() => scroll.evaluate((node) => node.scrollWidth))
    .toBe(scrollWidthBeforeEndEdit);
  const projectResponse = await page.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  const project = (await projectResponse.json()) as {
    pending_edits: { id: string; source_start: number; source_end: number }[];
  };
  const draggedEdit = project.pending_edits.find(
    (edit) => edit.source_start === 4 && edit.source_end === 4.8,
  );
  const wideEdit = project.pending_edits.find(
    (edit) => edit.source_start === 20 && edit.source_end === 28,
  );
  expect(draggedEdit).toBeTruthy();
  expect(wideEdit).toBeTruthy();
  const draggedEditId = draggedEdit!.id;
  const dragRegion = page.locator(
    `.pending-overlay[data-pending-id="${draggedEditId}"]`,
  );
  await expect(dragRegion.first()).toBeVisible();
  const dragHit = dragRegion.first().locator(".pending-hit");
  await dragHit.focus();
  await dragHit.press("Enter");
  for (
    let zoomStep = 0;
    zoomStep < 12 &&
    ((await dragRegion.first().boundingBox())?.width ?? 0) < 132;
    zoomStep += 1
  ) {
    await page.keyboard.press("=");
  }
  const updateCommands: { payload?: Record<string, unknown> }[] = [];
  page.on("request", (request) => {
    if (!request.url().includes("/api/document/command")) return;
    try {
      const command = request.postDataJSON() as {
        type?: string;
        payload?: Record<string, unknown>;
      };
      if (command.type === "UpdatePendingEdit") updateCommands.push(command);
    } catch {
      // Other document requests may not carry JSON.
    }
  });
  await expect(page.locator(".pending-actionbar")).toBeVisible();
  const startHandle = dragRegion.locator(".pending-handle.start");
  await expect(startHandle).toBeVisible();
  await startHandle.scrollIntoViewIfNeeded();
  const handleBox = await startHandle.boundingBox();
  expect(handleBox).toBeTruthy();
  const handlePoint = {
    x: handleBox!.x + handleBox!.width / 2,
    y: handleBox!.y + handleBox!.height / 2,
  };
  const hitClass = await page.evaluate(({ x, y }) => {
    return document.elementFromPoint(x, y)?.className;
  }, handlePoint);
  expect(hitClass).toContain("pending-handle start");
  const updateRequest = page.waitForRequest((request) => {
    if (!request.url().includes("/api/document/command")) return false;
    try {
      return request.postDataJSON()?.type === "UpdatePendingEdit";
    } catch {
      return false;
    }
  });
  await page.mouse.move(handlePoint.x, handlePoint.y);
  await page.mouse.down();
  await page.mouse.move(handlePoint.x + 80, handlePoint.y, { steps: 6 });
  await page.mouse.up();
  const update = await updateRequest;
  const payload = update.postDataJSON()?.payload as Record<string, unknown>;
  expect(payload).toMatchObject({ id: draggedEditId, snap: false });
  expect(payload.start).toBeGreaterThan(4);
  expect(payload.end).toBe(4.8);
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
      );
      const project = (await response.json()) as {
        pending_edits: {
          id: string;
          source_start: number;
          source_end: number;
        }[];
      };
      const edit = project.pending_edits.find(
        (candidate) => candidate.id === draggedEditId,
      );
      return edit && { start: edit.source_start, end: edit.source_end };
    })
    .toEqual({ start: payload.start, end: payload.end });
  expect(updateCommands).toHaveLength(1);
  // The phone timeline opens the compact drawer; at half height it shows the
  // pending inspector, and the next selection opens there too.
  await page.getByRole("button", { name: "Expand to half height" }).click();
  await expect(
    page.getByRole("heading", { name: "Pending edit" }),
  ).toBeVisible();
  const snapOption = page.getByLabel("Snap to silence");
  await expect(snapOption).toBeVisible();
  await expect(snapOption).toBeChecked();
  const snapOptionGeometry = await page
    .locator(".pending-snap-option")
    .evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    }));
  expect(snapOptionGeometry.scrollWidth).toBeLessThanOrEqual(
    snapOptionGeometry.clientWidth,
  );
  // Docked above the drawer, the card leaves timing to the drawer's fields.
  await expect(page.locator(".pending-actionbar")).toBeVisible();
  await expect(
    page
      .locator(".pending-actionbar")
      .getByRole("button", { name: "Edit timing" }),
  ).toHaveCount(0);
  const sourceStart = page.getByLabel("Source start");
  await sourceStart.tap();
  await expect(dragRegion.first()).toHaveAttribute(
    "data-coarse-pointer",
    "true",
  );
  await expect(sourceStart).toBeFocused();
  expect((await sourceStart.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(
    (await page.getByRole("button", { name: "Apply timing" }).boundingBox())
      ?.height,
  ).toBeGreaterThanOrEqual(44);
  await dragRegion.first().hover();
  await expect(page.locator(".pending-label--floating")).toHaveCount(0);

  const selected = page.locator(".pending-overlay.selected");
  const actionbar = page.locator(".pending-actionbar");
  await expect(actionbar).toBeVisible();
  const selectedBox = await selected.boundingBox();
  const actionBox = await actionbar.boundingBox();
  expect(selectedBox).toBeTruthy();
  expect(actionBox).toBeTruthy();
  expect(
    actionBox!.y >= selectedBox!.y + selectedBox!.height ||
      actionBox!.y + actionBox!.height <= selectedBox!.y,
  ).toBe(true);
  for (const name of ["Approve", "Reject"]) {
    const box = await actionbar.getByRole("button", { name }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }

  await page.mouse.move(15, 15);
  expect(
    await page.locator(".pending-label--floating").count(),
    "unselected tiny cuts do not stack floating labels",
  ).toBe(0);
  await regions.nth(2).hover();
  await expect(page.locator(".pending-label--floating")).toHaveCount(1);

  const wideRegion = page.locator(
    `.pending-overlay[data-pending-id="${wideEdit!.id}"]`,
  );
  await wideRegion.locator(".pending-hit").focus();
  await wideRegion.locator(".pending-hit").press("Enter");
  await page.getByLabel("Source start").tap();
  await wideRegion.locator(".pending-hit").focus();
  for (
    let zoomStep = 0;
    zoomStep < 8 && ((await wideRegion.boundingBox())?.width ?? 0) < 44;
    zoomStep += 1
  ) {
    await page.keyboard.press("=");
  }
  await expect(wideRegion).toHaveAttribute("data-coarse-handles", "ready");
  const [wideStartBox, wideEndBox, wideGeometry] = await Promise.all([
    wideRegion.locator(".pending-handle.start").boundingBox(),
    wideRegion.locator(".pending-handle.end").boundingBox(),
    wideRegion.evaluate((region) => {
      const bounds = region.getBoundingClientRect();
      const style = getComputedStyle(region);
      const center =
        bounds.left +
        bounds.width / 2 +
        Number.parseFloat(style.getPropertyValue("--pending-region-offset"));
      const width = Number.parseFloat(
        style.getPropertyValue("--pending-region-width"),
      );
      return { left: center - width / 2, right: center + width / 2 };
    }),
  ]);
  expect(wideStartBox).toBeTruthy();
  expect(wideEndBox).toBeTruthy();
  expect(wideStartBox!.x).toBeGreaterThanOrEqual(wideGeometry.left - 1);
  expect(wideStartBox!.x + wideStartBox!.width).toBeLessThanOrEqual(
    wideGeometry.right + 1,
  );
  expect(wideEndBox!.x).toBeGreaterThanOrEqual(wideGeometry.left - 1);
  expect(wideEndBox!.x + wideEndBox!.width).toBeLessThanOrEqual(
    wideGeometry.right + 1,
  );
  expect(wideStartBox!.height).toBeGreaterThanOrEqual(44);
  expect(wideEndBox!.height).toBeGreaterThanOrEqual(44);
  const touchStartHandle = wideRegion.locator(".pending-handle.start");
  await touchStartHandle.scrollIntoViewIfNeeded();
  await expect(touchStartHandle).toBeVisible();
  const touchHandleBox = await touchStartHandle.boundingBox();
  expect(touchHandleBox).toBeTruthy();
  const touchPoint = {
    x: touchHandleBox!.x + touchHandleBox!.width / 2,
    y: touchHandleBox!.y + touchHandleBox!.height / 2,
  };
  expect(
    await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return {
        isHandle: target?.classList.contains("pending-handle"),
        touchAction: target ? getComputedStyle(target).touchAction : null,
      };
    }, touchPoint),
  ).toEqual({ isHandle: true, touchAction: "none" });
  const touchUpdateCount = updateCommands.length;
  const touchUpdateRequest = page.waitForRequest(
    (request) => {
      if (!request.url().includes("/api/document/command")) return false;
      try {
        return request.postDataJSON()?.type === "UpdatePendingEdit";
      } catch {
        return false;
      }
    },
    { timeout: 15_000 },
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [touchPoint],
  });
  // The touch grammar: a long press arms the handle before it drags.
  await page.waitForTimeout(750);
  for (const delta of [5, 12, 20]) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ ...touchPoint, x: touchPoint.x + delta }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const touchUpdate = await touchUpdateRequest;
  expect(touchUpdate.postDataJSON()).toMatchObject({
    type: "UpdatePendingEdit",
    payload: { id: wideEdit!.id, snap: false, end: 28 },
  });
  expect(updateCommands).toHaveLength(touchUpdateCount + 1);
  const touchPayload = touchUpdate.postDataJSON()?.payload as {
    start: number;
    end: number;
  };
  expect(touchPayload.start).toBeGreaterThan(20);
  expect(touchPayload.end).toBe(28);
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
      );
      const current = (await response.json()) as {
        pending_edits: {
          id: string;
          source_start: number;
          source_end: number;
        }[];
      };
      const edit = current.pending_edits.find(
        (candidate) => candidate.id === wideEdit!.id,
      );
      return edit && { start: edit.source_start, end: edit.source_end };
    })
    .toEqual({ start: touchPayload.start, end: 28 });
  await wideRegion.locator(".pending-hit").focus();
  const undoRequest = page.waitForRequest((request) => {
    if (!request.url().includes("/api/document/command")) return false;
    try {
      return request.postDataJSON()?.type === "UndoHistory";
    } catch {
      return false;
    }
  });
  await page.keyboard.press("ControlOrMeta+Z");
  expect((await undoRequest).postDataJSON()).toMatchObject({
    type: "UndoHistory",
  });
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
      );
      const current = (await response.json()) as {
        pending_edits: {
          id: string;
          source_start: number;
          source_end: number;
        }[];
      };
      const edit = current.pending_edits.find(
        (candidate) => candidate.id === wideEdit!.id,
      );
      return edit && { start: edit.source_start, end: edit.source_end };
    })
    .toEqual({ start: 20, end: 28 });

  await page
    .getByRole("slider", { name: "Timeline position" })
    .click({ position: { x: 300, y: 12 } });
  await expect(page.locator(".pending-actionbar")).toHaveCount(0);
  await page.getByRole("button", { name: "Blade" }).click();
  await page
    .getByRole("slider", { name: "Timeline position" })
    .click({ position: { x: 300, y: 12 } });
  const bladeConfirmation = page.getByRole("dialog", {
    name: "Confirm blade cut",
  });
  await expect(bladeConfirmation).toBeVisible();
  // The confirmation's scrim; a toast may also offer a Dismiss link.
  await page.getByLabel("Dismiss", { exact: true }).click();
  await expect(bladeConfirmation).toHaveCount(0);
  const reselectHit = dragRegion.first().locator(".pending-hit");
  await reselectHit.focus();
  await reselectHit.press("Enter");

  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator(".daw-shell--desktop")).toBeVisible();
  await expect(actionbar).toBeVisible();
  const resizedActionBox = await actionbar.boundingBox();
  expect(resizedActionBox).toBeTruthy();
  expect(resizedActionBox!.x).toBeGreaterThanOrEqual(0);
  expect(resizedActionBox!.x + resizedActionBox!.width).toBeLessThanOrEqual(
    1280,
  );
  await scroll.evaluate((node) => {
    node.scrollLeft = node.scrollWidth - node.clientWidth;
  });
  const endBounds = await regions.last().evaluate((region) => {
    const lane = region.closest(".lane-inner");
    const regionBox = region.getBoundingClientRect();
    const laneBox = lane?.getBoundingClientRect();
    return {
      regionLeft: regionBox.left,
      regionRight: regionBox.right,
      laneLeft: laneBox?.left ?? Number.NaN,
      laneRight: laneBox?.right ?? Number.NaN,
    };
  });
  expect(endBounds.regionLeft).toBeGreaterThanOrEqual(endBounds.laneLeft - 1);
  expect(endBounds.regionRight).toBeLessThanOrEqual(endBounds.laneRight + 1);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
});
