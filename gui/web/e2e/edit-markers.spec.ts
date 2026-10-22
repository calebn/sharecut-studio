import { expect, type Page, test } from "@playwright/test";
import { rulerWidthPx } from "./deepZoom";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { switchE2eProject } from "./shareableProject";
import { setTheme, type Theme } from "./theme";
import { lane, shot, TRACK } from "./touchTimeline";

const CLIENT_ID = "e2e-edit-markers";
const SPLITS = [10, 11, 12, 40, 50];
const MARKS = `${lane} [data-hit-kind="join"], ${lane} [data-hit-kind="edit-chip"]`;
const VIEWPORTS = {
  phone: { width: 360, height: 800 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1280, height: 800 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;

test.use({ hasTouch: true });
test.describe.configure({ timeout: 180_000 });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async ({ page }) => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-edit-markers-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  for (const at_time of SPLITS) {
    await postDocumentCommand(
      page,
      CLIENT_ID,
      "SplitAtTime",
      { at_time, track_ids: [TRACK] },
      projectPath,
    );
  }
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

async function openFit(
  page: Page,
  viewport: ViewportName,
  theme: Theme,
): Promise<void> {
  await page.setViewportSize(VIEWPORTS[viewport]);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  if (viewport === "phone") await openPhoneTimeline(page);
  await setTheme(page, theme);
  await page
    .locator(".time-ruler")
    .first()
    .click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("\\");
  await page.keyboard.press("Escape");
  await expect(page.locator(`${lane} .edit-chip`)).toHaveCount(1);
}

async function centers(page: Page): Promise<number[]> {
  return page.evaluate((selector) => {
    const xs = [...document.querySelectorAll(selector)].map((el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    return xs.sort((a, b) => a - b);
  }, MARKS);
}

for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
  for (const theme of ["light", "dark"] as const) {
    test(`at fit zoom the three close joins fold into one chip, the rest stay glyphs, at ${viewport} in the ${theme} theme`, async ({
      page,
    }, info) => {
      await openFit(page, viewport, theme);
      const chip = page.locator(`${lane} .edit-chip`);
      await expect(chip).toHaveText("3");
      await expect(chip).toHaveAttribute(
        "aria-label",
        /^3 edits: .+\. Zoom in$/,
      );
      await expect(page.locator(`${lane} .edit-mark`)).toHaveCount(2);
      const xs = await centers(page);
      expect(xs).toHaveLength(3);
      for (let i = 1; i < xs.length; i += 1) {
        expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(23.5);
      }
      await shot(info, page, `edit-markers-${viewport}-${theme}`);
    });
  }
}

test("a tap on the chip zooms in and splits it into its joins", async ({
  page,
}) => {
  await openFit(page, "phone", "dark");
  const before = await rulerWidthPx(page);
  const chip = page.locator(`${lane} .edit-chip`);
  const box = await chip.boundingBox();
  if (!box) throw new Error("chip has no box");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(`${lane} .edit-chip`)).toHaveCount(0);
  await expect(page.locator(`${lane} .edit-mark`)).toHaveCount(5);
  expect(await rulerWidthPx(page)).toBeGreaterThan(before);
});

test.describe("coarse pointer", () => {
  test.use({ isMobile: true });

  test("a touch 20 px beside a glyph still opens its join", async ({
    page,
  }) => {
    await openFit(page, "phone", "dark");
    const glyph = page.locator(`${lane} .edit-mark`).last();
    await glyph.evaluate((el) =>
      el.scrollIntoView({ block: "center", inline: "center" }),
    );
    const box = await glyph.boundingBox();
    if (!box) throw new Error("glyph has no box");
    await page.touchscreen.tap(box.x + box.width + 20, box.y + box.height / 2);
    await expect(glyph).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("dialog", { name: /join at/ })).toBeVisible();
  });
});

test("a chip still zooms in blade mode", async ({ page }) => {
  await openFit(page, "desktop", "dark");
  await page.getByRole("button", { name: "Blade tool", exact: true }).click();
  const before = await rulerWidthPx(page);
  await page.locator(`${lane} .edit-chip`).click();
  await expect(page.locator(`${lane} .edit-chip`)).toHaveCount(0);
  expect(await rulerWidthPx(page)).toBeGreaterThan(before);
  await expect(page.getByRole("dialog", { name: /^Cut at / })).toHaveCount(0);
});
