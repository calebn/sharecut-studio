import { expect, type Page, test } from "@playwright/test";
import { expectSurfaceAxeClean } from "./axe";
import { expectFeedback } from "./feedback";
import { chooseHomeMenuItem, openHome } from "./home";
import {
  expectNoHorizontalScroll,
  expectTouchTargets,
  mockBootstrap,
  prepare,
  shot,
} from "./modelsMock";
import { setRootFontSize } from "./rootFontSize";
import { withAppearance } from "./theme";

const CELLS = [
  { name: "390x844", width: 390, height: 844, fontPx: null },
  { name: "320x568-200pct", width: 320, height: 568, fontPx: 32 },
] as const;

type Row = Record<string, unknown>;

const SEGMENT: Row = {
  id: "cold-open-1a2b3c4d",
  name: "Cold open",
  kind: "intro",
  version: 1,
  versions: [1],
  clips: [{ audio: "intro.flac", offset_sec: 0, duration_sec: 12.4 }],
};

const KITS: Row[] = [
  {
    id: "show-kit-1a2b3c4d",
    name: "Show Kit",
    version: 2,
    versions: [1, 2],
    entries: 2,
    missing: 0,
    usable: true,
    problem: null,
  },
  {
    id: "launch-week-21bc0000",
    name: "Launch week with a rather long name that has to wrap",
    version: 1,
    versions: [1],
    entries: 3,
    missing: 1,
    usable: false,
    problem:
      "1 segment of this kit is not in the library: entry 2 (Sponsor read at end): that segment can't be found.",
  },
  {
    id: "old-kit-77de0000",
    damaged: true,
    version: 1,
    usable: false,
    problem: "Version 1 can't be read: kit.json is not valid JSON.",
    code: "kit_invalid",
  },
];

type Mock = { lists: number; exports: string[] };

async function mockKits(page: Page, rows: Row[] = KITS): Promise<Mock> {
  const mock: Mock = { lists: 0, exports: [] };
  await page.route(
    (url) => url.pathname === "/api/segments",
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ json: [SEGMENT] });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith("/api/kits"),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/kits") {
        mock.lists += 1;
        await route.fulfill({ json: rows });
        return;
      }
      const exported = url.pathname.match(/^\/api\/kits\/([^/]+)\/export$/);
      if (exported) {
        mock.exports.push(exported[1]);
        await route.fulfill({
          contentType: "application/zip",
          headers: {
            "content-disposition":
              'attachment; filename="show-kit.sharecutkit"',
          },
          body: Buffer.from("PK-kit"),
        });
        return;
      }
      await route.fallback();
    },
  );
  return mock;
}

for (const { cell, theme, reducedMotion } of withAppearance(CELLS)) {
  test.describe(`kit library phone ${cell.name}`, () => {
    test.use({
      viewport: { width: cell.width, height: cell.height },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 1,
    });

    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({
        reducedMotion: reducedMotion ? "reduce" : "no-preference",
      });
      await prepare(page, theme, true);
      await mockBootstrap(page);
    });

    async function home(page: Page, rows?: Row[]) {
      const mock = await mockKits(page, rows);
      await openHome(page);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      const section = page.getByRole("region", { name: "Kits" });
      await expect(section).toBeVisible();
      return { mock, section };
    }

    test("lists healthy, unusable and damaged kits with 44 px controls and no sideways scroll", async ({
      page,
    }) => {
      const { section } = await home(page);
      const list = section.getByRole("list", { name: "Saved kits" });
      await expect(list.getByRole("listitem")).toHaveCount(3);
      await expect(section).toContainText("2 segments");
      await expect(section).toContainText("v2 · 2 versions");
      await expect(section).toContainText("Can't be added to an episode yet");
      await expect(section).toContainText(
        "Sponsor read at end): that segment can't be found.",
      );
      await expect(section).toContainText(
        "It can't be exported until its segments are back",
      );
      await expect(section).toContainText("Unreadable kit");
      await expect(section).toContainText("old-kit-77de0000");
      await expect(section).toContainText("Can't be read");
      await expect(
        section.getByRole("button", { name: /^More actions for/ }),
      ).toHaveCount(1);
      await section.scrollIntoViewIfNeeded();
      await expectTouchTargets(section);
      for (const item of await list.getByRole("listitem").all()) {
        const box = await item.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(43);
      }
      await expectNoHorizontalScroll(page);
      await expectSurfaceAxeClean(page, ".sys-home");
      await shot(page, cell.name, theme, "kit-library");
    });

    test("Export as file downloads the kit file and the damaged row offers none", async ({
      page,
    }) => {
      const { mock, section } = await home(page);
      await section
        .getByRole("button", { name: "More actions for Show Kit" })
        .tap();
      const item = page.getByRole("menuitem", { name: "Export as file" });
      await expect(item).toBeVisible();
      const box = await item.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(43);
      const downloading = page.waitForEvent("download");
      await item.tap();
      expect((await downloading).suggestedFilename()).toBe(
        "show-kit.sharecutkit",
      );
      expect(mock.exports).toEqual(["show-kit-1a2b3c4d"]);
      await expectFeedback(page, "Saved show-kit.sharecutkit");
      await expectNoHorizontalScroll(page);
    });

    test("the Library sheet still scrolls to the last kit row", async ({
      page,
    }) => {
      const mock = await mockKits(page);
      await openHome(page);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      await expect.poll(() => mock.lists).toBeGreaterThan(0);
      const before = mock.lists;
      await chooseHomeMenuItem(page, "Settings");
      await page
        .getByRole("dialog", { name: "Settings" })
        .getByRole("button", { name: "Segment library" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Segment library" });
      await expect(dialog).toBeVisible();
      // Opening the sheet reads the kits again.
      await expect.poll(() => mock.lists).toBeGreaterThan(before);
      const last = dialog.locator("[data-kit-row]").last();
      await expect(last).toHaveAttribute("data-kit-row", "old-kit-77de0000");
      const scroller = dialog.locator(".sys-sheet-scroll");
      if (cell.fontPx) {
        // At 200% text the list is taller than the sheet, so scrolling has to work.
        await expect
          .poll(() =>
            scroller.evaluate((el) => el.scrollHeight > el.clientHeight),
          )
          .toBe(true);
      }
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect
        .poll(async () => {
          const body = await scroller.boundingBox();
          const row = await last.boundingBox();
          if (!body || !row) return false;
          // At 200% text the last row can be taller than the sheet, so only its end has to show.
          return row.y + row.height <= body.y + body.height + 1;
        })
        .toBe(true);
      await expectNoHorizontalScroll(page);
    });

    test("is left out of Home when there are no kits", async ({ page }) => {
      const mock = await mockKits(page, []);
      await openHome(page);
      await expect(
        page.getByRole("region", { name: "Segment library" }),
      ).toBeVisible();
      await expect.poll(() => mock.lists).toBeGreaterThan(0);
      await expect(page.getByRole("region", { name: "Kits" })).toHaveCount(0);
    });
  });
}
