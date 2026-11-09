import { expect, type Locator, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject } from "./shareableProject";
import { goToStage, inspectSelection, openProject, phone } from "./stageNav";
import { projectJson } from "./touchTimeline";

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-seams-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

const bar = (page: Page) =>
  page.getByRole("group", { name: /^(Selection|Edit) actions$/ });

const glyphs = (page: Page) =>
  page.locator(".lane-row").first().locator(".edit-mark");

async function historyLength(page: Page): Promise<number> {
  const body = (await projectJson(page, projectPath)) as unknown as {
    history?: { entries?: unknown[] };
  };
  return body.history?.entries?.length ?? 0;
}

async function waiveRefineGate(page: Page): Promise<void> {
  await page.request.post("/api/transcript/refine/waive", {
    data: { path: projectPath, reason: "e2e seams" },
  });
}

async function blurFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
}

async function cutTwoRanges(page: Page): Promise<void> {
  const command = (payload: Record<string, unknown>) =>
    postDocumentCommand(
      page,
      "e2e-seams",
      "CutRange",
      { ...payload, mode: "ripple" },
      projectPath,
    );
  await waiveRefineGate(page);
  await command({ start: 40, end: 50 });
  await waiveRefineGate(page);
  await command({ start: 5, end: 15 });
}

async function openEdit(page: Page): Promise<void> {
  await openProject(page, projectPath);
  await goToStage(page, "edit");
  await expect(
    page.locator(".lane-row").first().locator(".clip-block"),
  ).not.toHaveCount(0);
}

async function splitAtPlayhead(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ControlOrMeta+K");
}

async function expectBarNames(page: Page, names: string[]): Promise<void> {
  const group = bar(page);
  await expect(group).toBeVisible();
  for (const name of names) {
    await expect(
      group.getByRole(name === "Join type" ? "group" : "button", { name }),
    ).toBeVisible();
  }
}

test.describe("Seam selection", () => {
  test("a cut seam selects from its glyph, Keep restores it in one History entry, Undo cuts it again", async ({
    page,
  }) => {
    await openEdit(page);
    await cutTwoRanges(page);
    await expect(
      page.locator(".lane-row").first().locator(".clip-block"),
    ).toHaveCount(3);
    const before = await historyLength(page);

    const glyph = glyphs(page).first();
    await glyph.click();
    await expect(glyph).toHaveAttribute("aria-pressed", "true");
    await expectBarNames(page, [
      "Hear",
      "Join type",
      "Keep",
      "Comment",
      "Inspect",
    ]);

    await bar(page).getByRole("button", { name: "Keep", exact: true }).click();
    await expect(
      page.locator(".lane-row").first().locator(".clip-block"),
    ).toHaveCount(4);
    await expect.poll(() => historyLength(page)).toBe(before + 1);

    await page.keyboard.press("ControlOrMeta+Z");
    await expect(
      page.locator(".lane-row").first().locator(".clip-block"),
    ).toHaveCount(3);
  });

  test("a split seam is selectable and offers no Keep", async ({ page }) => {
    await openEdit(page);
    const lane = page.locator(".lane-row").first();
    const clips = lane.locator(".clip-block");
    const start = await clips.count();
    await splitAtPlayhead(page);
    await expect(clips).toHaveCount(start + 1);
    const glyph = glyphs(page).first();
    await glyph.click();
    await expect(glyph).toHaveAttribute("aria-pressed", "true");
    await expectBarNames(page, ["Hear", "Join type", "Comment", "Inspect"]);
    await expect(
      bar(page).getByRole("button", { name: "Keep", exact: true }),
    ).toHaveCount(0);
  });

  test("the Script pill and the glyph select the same seam", async ({
    page,
  }) => {
    await openEdit(page);
    await cutTwoRanges(page);
    await openProject(page, projectPath);
    await goToStage(page, "edit");
    const glyph = glyphs(page).first();
    await expect(glyph).toBeVisible();
    await glyph.click();
    await expect(glyph).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(glyph).toHaveAttribute("aria-pressed", "false");
    const pill = page.locator(".sys-script-pill button").first();
    await pill.click();
    await expect(glyph).toHaveAttribute("aria-pressed", "true");
  });

  test("the join type persists after a reload and the length survives Undo and Redo with the sheet open", async ({
    page,
  }) => {
    await openEdit(page);
    await splitAtPlayhead(page);
    const glyph = glyphs(page).first();
    await glyph.click();
    const join = bar(page).getByRole("group", { name: "Join type" });
    await join.getByRole("button", { name: "Fade", exact: true }).click();
    await expect(
      join.getByRole("button", { name: "Fade", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    await page.reload();
    await goToStage(page, "edit");
    await glyphs(page).first().click();
    await expect(
      bar(page)
        .getByRole("group", { name: "Join type" })
        .getByRole("button", { name: "Fade", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    await inspectSelection(page);
    const length = page.getByRole("spinbutton", { name: "Length" });
    await expect(length).toBeVisible();
    const saved = await length.getAttribute("aria-valuenow");
    await length.focus();
    await page.keyboard.press("ArrowUp");
    await expect(length).not.toHaveAttribute("aria-valuenow", saved ?? "");
    const changed = await length.getAttribute("aria-valuenow");

    await blurFocus(page);
    await page.keyboard.press("ControlOrMeta+Z");
    await expect(length).toHaveAttribute("aria-valuenow", saved ?? "");
    await blurFocus(page);
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect(length).toHaveAttribute("aria-valuenow", changed ?? "");
  });

  test("on a phone the seam sheet docks with the bar", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await openEdit(page);
    await phone.show(page, "timeline");
    await splitAtPlayhead(page);
    const glyph = glyphs(page).first();
    await glyph.click();
    await inspectSelection(page);
    const sheet: Locator = page.getByRole("dialog", {
      name: "Inspector",
      exact: true,
    });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("spinbutton", { name: "Length" })).toHaveCount(
      1,
    );
  });
});
