import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { postDocumentCommand, postHistoryMove } from "./documentCommand";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { openSuggestedPendingEdit } from "./pendingEdit";
import { openPhoneTimeline, rememberInspectorDetent } from "./phoneTimeline";
import { switchE2eProject } from "./shareableProject";
import { inspectSelection, openProject, waitForLanding } from "./stageNav";

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-transitions-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async ({ page }) => {
  await page.close();
  await switchE2eProject(e2eProjectPath);
  removeRelocatedE2eProject(workspaceDir);
});

async function pendingSnapshot(page: Page) {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    pending_edits: {
      id: string;
      track_id: string;
      source_start: number;
      source_end: number;
    }[];
  };
}

test("pending suggestions show a compact card, keep drafts and save a typed start", async ({
  page,
  browser,
}, testInfo) => {
  await openSuggestedPendingEdit(page, projectPath);
  const created = (await pendingSnapshot(page)).pending_edits.find(
    (edit) => edit.source_start === 0 && edit.source_end === 2,
  );
  expect(created).toBeTruthy();
  const editId = created!.id;
  await postDocumentCommand(
    page,
    "e2e-transitions",
    "UpdatePendingEdit",
    {
      id: editId,
      start: 2,
      end: 8,
      snap: false,
    },
    projectPath,
  );
  const sourceStart = page.getByLabel("Source start", { exact: true });
  await expect(sourceStart).toHaveAttribute("aria-valuetext", "2.000000 s");
  const before = fs.readFileSync(projectPath, "utf8");
  await sourceStart.press("Enter");
  const startInput = page.getByRole("textbox", {
    name: "Source start",
    exact: true,
  });
  await startInput.fill("2.25");
  expect(fs.readFileSync(projectPath, "utf8")).toBe(before);
  await startInput.press("Alt+Enter");
  await expect
    .poll(async () => {
      const current = (await pendingSnapshot(page)).pending_edits.find(
        (edit) => edit.id === editId,
      );
      return (
        current && { start: current.source_start, end: current.source_end }
      );
    })
    .toEqual({ start: 2.25, end: 8 });
  await expectPageAxeClean(page, ".inspector");
  await expect(
    page.locator('.inspector .sys-decision[data-layout="compact"]'),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("pending-desktop.png") });
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const phone = await phoneContext.newPage();
    // The phone timeline's drawer opens at full height, with the inspector.
    await rememberInspectorDetent(phone, "full");
    await phone.goto(page.url());
    await waitForLanding(phone);
    await openPhoneTimeline(phone);
    await phone
      .locator(`.pending-overlay[data-pending-id="${editId}"] .pending-hit`)
      .first()
      .focus();
    await phone.keyboard.press("Enter");
    await inspectSelection(phone);
    const expand = phone.getByRole("button", { name: "Expand", exact: true });
    if (await expand.isVisible()) await expand.click();
    const phoneStart = phone.getByLabel("Source start", { exact: true });
    await expect(phoneStart).toBeVisible();
    expect((await phoneStart.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expectPageAxeClean(phone);
    await phone.screenshot({ path: testInfo.outputPath("pending-phone.png") });
  } finally {
    await phoneContext.close();
  }
});

test("clip names identify audio and pending hatching fills the lane", async ({
  page,
}) => {
  await openSuggestedPendingEdit(page, projectPath);
  const region = page.locator(".pending-overlay").first();
  const geometry = await region.evaluate((element) => {
    const lane = element.closest(".lane-inner");
    if (!lane) throw new Error("pending region has no lane");
    const bounds = element.getBoundingClientRect();
    const laneBounds = lane.getBoundingClientRect();
    return {
      top: bounds.top,
      bottom: bounds.bottom,
      laneTop: laneBounds.top,
      laneBottom: laneBounds.bottom,
    };
  });
  expect(Math.abs(geometry.top - geometry.laneTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.bottom - geometry.laneBottom)).toBeLessThanOrEqual(
    1,
  );
  const block = page.locator(".lane-row .clip-block").first();
  const clipId = await block.getAttribute("data-clip-id");
  expect(clipId).toBeTruthy();
  const hit = block.locator(".clip-hit");
  const name = await hit.getAttribute("aria-label");
  expect(name).not.toContain(clipId!);
  expect(name).toMatch(/Select .+ clip .+\d/);
  await hit.click();
  await inspectSelection(page);
  const sheet = page.getByRole("dialog", { name: "Inspector" });
  await expect(
    sheet.getByRole("spinbutton", { name: "Source start", exact: true }),
  ).toBeVisible();
  await expect(sheet).not.toContainText(clipId!);
  await expectPageAxeClean(page, ".sys-inspector");
});

test("the Seam diamond rolls one join and Undo restores both clip bounds", async ({
  page,
}) => {
  await openProject(page, projectPath);
  const clips = page.locator(".lane-row").first().locator(".clip-block");
  await expect(clips).toHaveCount(1);
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("ControlOrMeta+K");
  await expect(clips).toHaveCount(2);
  const rightId = await clips.nth(1).getAttribute("data-clip-id");
  await clips.nth(1).locator(".clip-hit").click();
  const seam = page
    .locator(".lane-row")
    .first()
    .locator(".seam-mark .sys-seam-hit");
  await expect(seam).toBeVisible();
  const box = await seam.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.width).toBeGreaterThanOrEqual(24);
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest(".sys-seam-hit") != null,
      point,
    ),
  ).toBe(true);
  const beforeResponse = await page.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  const before = await beforeResponse.json();
  const beforePair = Object.values(before.clips.tracks).find(
    (rows) => Array.isArray(rows) && rows.some((row) => row.id === rightId),
  ) as { id: string; source_start: number; source_end: number }[];
  const rolled = page.waitForResponse(
    (response) =>
      response.url().includes("/api/document/command") &&
      response.request().postDataJSON()?.type === "RollClipJoin",
  );
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 25, point.y, { steps: 5 });
  await page.mouse.up();
  const response = await rolled;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON().payload.delta_sec).not.toBe(0);
  const afterResponse = await page.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  const after = await afterResponse.json();
  const afterPair = Object.values(after.clips.tracks).find(
    (rows) => Array.isArray(rows) && rows.some((row) => row.id === rightId),
  ) as typeof beforePair;
  expect(afterPair[0].source_end).toBe(afterPair[1].source_start);
  expect(
    afterPair.reduce((sum, row) => sum + row.source_end - row.source_start, 0),
  ).toBeCloseTo(
    beforePair.reduce((sum, row) => sum + row.source_end - row.source_start, 0),
    8,
  );
  await postHistoryMove(
    page,
    "e2e-transitions-roll",
    "UndoHistory",
    projectPath,
  );
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
      );
      const project = await response.json();
      return Object.values(project.clips.tracks).find(
        (rows) => Array.isArray(rows) && rows.some((row) => row.id === rightId),
      );
    })
    .toEqual(beforePair);
});
test("crossfade length saves block competing pointer fades until acknowledged", async ({
  page,
}) => {
  await openProject(page, projectPath);
  const lane = page.locator(".lane-row").first();
  await expect(lane.locator(".clip-block")).toHaveCount(1);
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("ControlOrMeta+K");
  await expect(lane.locator(".clip-block")).toHaveCount(2);
  await lane.locator(".seam-mark .sys-seam-hit").click();
  await page
    .getByRole("group", { name: /^(Selection|Edit) actions$/ })
    .getByRole("group", { name: "Join type" })
    .getByRole("button", { name: "Crossfade", exact: true })
    .click();
  await inspectSelection(page);
  const length = page.getByRole("spinbutton", { name: "Length" });
  await expect(length).toBeVisible();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received = false;
  const commands: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/document/command"))
      commands.push(request.postDataJSON().type);
  });
  await page.route("**/api/document/command*", async (route) => {
    if (route.request().postDataJSON().type !== "SetClipJoin")
      return route.continue();
    const response = await route.fetch();
    received = true;
    await held;
    await route.fulfill({ response });
  });
  try {
    await length.focus();
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => received).toBe(true);
    const fade = lane.locator(".clip-block").nth(0).locator(".fade-corner.in");
    await fade.focus();
    const f = (await fade.boundingBox())!;
    const x = f.x + f.width / 2,
      y = f.y + f.height / 2;
    expect(
      await fade.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return (
          document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) ===
          el
        );
      }),
    ).toBe(true);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 8, y);
    await expect(lane.locator(".fade-dragging")).toHaveCount(0);
    await page.mouse.up();
    expect(
      commands.filter(
        (type) => type === "RollClipJoin" || type === "SetClipFade",
      ),
    ).toEqual([]);
  } finally {
    release();
  }
  await expect(
    page
      .getByRole("group", { name: "Join type" })
      .getByRole("button", { name: "Fade", exact: true }),
  ).toBeEnabled();
  expect(commands.filter((type) => type === "SetClipJoin")).toHaveLength(1);
});

test("touch Seam diamond, fade corners, and trim strips retain distinct hit areas", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 844 },
    hasTouch: true,
  });
  await context.addInitScript(() =>
    localStorage.setItem(
      "sharecut.laneHeight",
      JSON.stringify({ mode: "fixed", px: 72 }),
    ),
  );
  try {
    const page = await context.newPage();
    await openProject(page, projectPath);
    const lane = page.locator(".lane-row").first();
    await expect(lane.locator(".clip-block")).toHaveCount(1);
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ControlOrMeta+K");
    await expect(lane.locator(".clip-block")).toHaveCount(2);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
    await lane.locator(".clip-block").nth(1).locator(".clip-hit").tap();
    const seam = lane.locator(".seam-mark .sys-seam-hit");
    const s = (await seam.boundingBox())!;
    expect(s.width).toBeGreaterThanOrEqual(44);
    expect(s.height).toBeGreaterThanOrEqual(44);
    expect((await lane.boundingBox())!.height).toBeGreaterThanOrEqual(104);
    expect(
      await seam.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return el.contains(
          document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2),
        );
      }),
    ).toBe(true);
    for (const [index, edge] of [
      [0, "out"],
      [1, "in"],
    ] as const) {
      const clip = lane.locator(".clip-block").nth(index);
      await clip.locator(".clip-hit").tap();
      const trim = clip.locator(`.trim-handle.${edge}`);
      expect(
        await trim.evaluate((el) => {
          const b = el.getBoundingClientRect();
          return (
            document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) ===
            el
          );
        }),
      ).toBe(true);
    }
    for (const edge of [
      lane.locator(".clip-block").nth(1).locator(".fade-corner.in"),
      lane.locator(".clip-block").nth(0).locator(".fade-corner.out"),
    ]) {
      await edge.focus();
      expect(
        await edge.evaluate((el) => {
          const b = el.getBoundingClientRect();
          const face = el
            .closest(".lane-row")!
            .querySelector(".seam-mark .sys-seam-diamond")!
            .getBoundingClientRect();
          return (
            b.right <= face.left ||
            face.right <= b.left ||
            b.bottom <= face.top ||
            face.bottom <= b.top
          );
        }),
      ).toBe(true);
    }
  } finally {
    await context.close();
  }
});
