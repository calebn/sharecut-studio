import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { postDocumentCommand } from "../e2e/documentCommand";
import { e2eProjectPath } from "../e2e/env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { switchE2eProject } from "../e2e/shareableProject";
import { setTheme, type Theme } from "../e2e/theme";
import { save } from "../e2e/touchTimeline";

const CLIENT_ID = "e2e-actionbar-ruler";
type Outcome = "docked" | "floating" | "covered" | "inline";

/**
 * Where the review actions end up: docked in the compact sheet; floating
 * between the sticky ruler and the bottom panel; floating there but covered
 * by the open inspector sheet of a tall tablet, whose own buttons take over;
 * or, when the card cannot fit between ruler and panel, left to the
 * inspector's inline controls.
 */
const VIEWPORTS: Record<
  string,
  { width: number; height: number; outcome: Outcome }
> = {
  phone: { width: 360, height: 800, outcome: "docked" },
  "tablet-short": { width: 768, height: 500, outcome: "docked" },
  tablet: { width: 820, height: 1180, outcome: "covered" },
  desktop: { width: 1280, height: 720, outcome: "floating" },
  "desktop-540": { width: 1280, height: 540, outcome: "floating" },
  "desktop-500": { width: 1280, height: 500, outcome: "floating" },
  "desktop-short": { width: 1280, height: 440, outcome: "inline" },
};

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-actionbar-ruler-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});
test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

async function suggestOnFirstDialogueTrack(page: Page): Promise<void> {
  const trackId = await page.evaluate(async (path) => {
    const res = await fetch(
      `/api/project?path=${encodeURIComponent(path)}&phase=shell`,
    );
    const project = (await res.json()) as {
      tracks: { id: string; role?: string }[];
    };
    return project.tracks.find((t) => t.role === "dialogue")?.id;
  }, projectPath);
  expect(trackId).toBeTruthy();
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "AddChapter",
    { time: 15, title: "Ruler chapter" },
    projectPath,
  );
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "AddComment",
    {
      body: "Ruler comment",
      author: "Playwright",
      timeline_start: 25,
      timeline_end: 28,
    },
    projectPath,
  );
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "SuggestPendingEdit",
    { track_id: trackId, start: 4, end: 6, reason: "guest:suggest" },
    projectPath,
  );
}

interface Box {
  top: number;
  bottom: number;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** The rects the card must stay between; throws when the chrome is missing. */
async function chromeBoxes(page: Page): Promise<{
  ruler: Box;
  marker: Box;
  panel: Box;
}> {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`${selector} is missing`);
      const { top, bottom } = el.getBoundingClientRect();
      return { top, bottom };
    };
    return {
      ruler: box(".time-ruler"),
      marker: box(".marker-lane"),
      panel: box(".bottom-tabs"),
    };
  });
}

async function expectHitTestable(button: Locator): Promise<void> {
  await expect(button).toBeVisible();
  const reachable = await button.evaluate((el) => {
    const { left, top, width, height } = el.getBoundingClientRect();
    const hit = document.elementFromPoint(left + width / 2, top + height / 2);
    return hit !== null && el.contains(hit);
  });
  expect(reachable).toBe(true);
}

async function expectCardOutcome(
  { page, browserName }: { page: Page; browserName: string },
  info: TestInfo,
  name: string,
  theme: Theme,
): Promise<void> {
  test.setTimeout(40_000);
  const { outcome, ...size } = VIEWPORTS[name];
  await page.setViewportSize(size);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  await suggestOnFirstDialogueTrack(page);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  if (name === "phone") await openPhoneTimeline(page);
  await setTheme(page, theme);
  await page
    .locator("[data-pending-id]")
    .last()
    .click({
      position: { x: 4, y: 4 },
    });
  const bar = page.locator(".pending-actionbar");
  await expect(bar).toBeAttached();
  await page.locator(".timeline-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await settle(page);
  save(info, `${browserName}-${name}-${theme}.png`, await page.screenshot());

  if (outcome === "docked") {
    await expect(bar).toHaveClass(/pending-actionbar--docked/);
    expect(
      await bar.evaluate((el) => el.closest(".bottom-sheet--compact") !== null),
    ).toBe(true);
    await expectHitTestable(bar.getByRole("button", { name: "Approve" }));
    await expectHitTestable(bar.getByRole("button", { name: "Reject" }));
    return;
  }
  await expect(bar).not.toHaveClass(/pending-actionbar--docked/);
  if (outcome === "inline") {
    await expect(bar).toBeHidden();
    await expectHitTestable(page.getByRole("button", { name: "Approve" }));
    await expectHitTestable(page.getByRole("button", { name: "Reject" }));
    return;
  }
  await expect(bar).toBeVisible();
  const { top, bottom } = await bar.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  });
  const { ruler, marker, panel } = await chromeBoxes(page);
  expect(top).toBeGreaterThanOrEqual(
    Math.max(ruler.bottom, marker.bottom) - 0.5,
  );
  expect(bottom).toBeLessThanOrEqual(panel.top + 0.5);
  const actions =
    outcome === "covered" ? page.locator(".bottom-sheet-root") : bar;
  await expectHitTestable(actions.getByRole("button", { name: "Approve" }));
  await expectHitTestable(actions.getByRole("button", { name: "Reject" }));
}

test("pending actions at phone: docks in the inspector sheet, light", ({
  page,
  browserName,
}, info) => expectCardOutcome({ page, browserName }, info, "phone", "light"));
test("pending actions at phone: docks in the inspector sheet, dark", ({
  page,
  browserName,
}, info) => expectCardOutcome({ page, browserName }, info, "phone", "dark"));
test("pending actions at tablet-short: docks in the inspector sheet, light", ({
  page,
  browserName,
}, info) =>
  expectCardOutcome({ page, browserName }, info, "tablet-short", "light"));
test("pending actions at tablet-short: docks in the inspector sheet, dark", ({
  page,
  browserName,
}, info) =>
  expectCardOutcome({ page, browserName }, info, "tablet-short", "dark"));
test("pending actions at tablet: floats under the open inspector sheet, light", ({
  page,
  browserName,
}, info) => expectCardOutcome({ page, browserName }, info, "tablet", "light"));
test("pending actions at tablet: floats under the open inspector sheet, dark", ({
  page,
  browserName,
}, info) => expectCardOutcome({ page, browserName }, info, "tablet", "dark"));
test("pending actions at desktop: floats between the ruler and the bottom panel, light", ({
  page,
  browserName,
}, info) => expectCardOutcome({ page, browserName }, info, "desktop", "light"));
test("pending actions at desktop: floats between the ruler and the bottom panel, dark", ({
  page,
  browserName,
}, info) => expectCardOutcome({ page, browserName }, info, "desktop", "dark"));
test("pending actions at desktop-540: floats between the ruler and the bottom panel, light", ({
  page,
  browserName,
}, info) =>
  expectCardOutcome({ page, browserName }, info, "desktop-540", "light"));
test("pending actions at desktop-540: floats between the ruler and the bottom panel, dark", ({
  page,
  browserName,
}, info) =>
  expectCardOutcome({ page, browserName }, info, "desktop-540", "dark"));
test("pending actions at desktop-500: floats between the ruler and the bottom panel, light", ({
  page,
  browserName,
}, info) =>
  expectCardOutcome({ page, browserName }, info, "desktop-500", "light"));
test("pending actions at desktop-500: floats between the ruler and the bottom panel, dark", ({
  page,
  browserName,
}, info) =>
  expectCardOutcome({ page, browserName }, info, "desktop-500", "dark"));
test("pending actions at desktop-short: leaves Approve and Reject to the inspector, light", ({
  page,
  browserName,
}, info) =>
  expectCardOutcome({ page, browserName }, info, "desktop-short", "light"));
test("pending actions at desktop-short: leaves Approve and Reject to the inspector, dark", ({
  page,
  browserName,
}, info) =>
  expectCardOutcome({ page, browserName }, info, "desktop-short", "dark"));
