import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectReadingSurfaceAxeClean, expectSurfaceAxeClean } from "./axe";
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

/** The Segment library on Home and in its sheet, on an iPhone and on a desktop, with /api/segments mocked. */

type MockRow = Record<string, unknown>;

const LIBRARY: MockRow[] = [
  {
    id: "intro-9f3a",
    name: "Cold open",
    kind: "intro",
    version: 1,
    versions: [1],
    clips: [{ audio: "intro.flac", offset_sec: 0, duration_sec: 12.4 }],
  },
  {
    id: "sponsor-21bc",
    name: "Acme sponsor read with a long name that has to wrap under text zoom",
    kind: "sponsor",
    version: 3,
    versions: [1, 2, 3],
    clips: [
      { audio: "a.flac", offset_sec: 0, duration_sec: 20 },
      { audio: "b.flac", offset_sec: 20, duration_sec: 14.6 },
    ],
  },
  {
    id: "outro-77de",
    version: 2,
    damaged: true,
    problem: "Version 2 has no readable audio: clips/outro.flac is missing.",
    code: "segment_media_invalid",
  },
];

function silence(): Buffer {
  const rate = 8000;
  const samples = Math.round(rate * 0.3);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, Buffer.alloc(samples, 128)]);
}

type Mock = { deletes: string[]; audio: string[] };

async function mockSegments(page: Page, rows: MockRow[]): Promise<Mock> {
  const mock: Mock = { deletes: [], audio: [] };
  const remaining = [...rows];
  await page.route(
    (url) => url.pathname.startsWith("/api/segments"),
    async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      if (url.pathname === "/api/segments" && method === "GET") {
        await route.fulfill({ json: remaining });
        return;
      }
      const audio = url.pathname.match(/^\/api\/segments\/([^/]+)\/audio$/);
      if (audio && method === "GET") {
        mock.audio.push(`${audio[1]}?${url.searchParams.toString()}`);
        await route.fulfill({ contentType: "audio/wav", body: silence() });
        return;
      }
      const one = url.pathname.match(/^\/api\/segments\/([^/]+)$/);
      if (one && method === "DELETE") {
        const id = decodeURIComponent(one[1]);
        mock.deletes.push(id);
        const at = remaining.findIndex((row) => row.id === id);
        if (at >= 0) remaining.splice(at, 1);
        await route.fulfill({ status: 204, body: "" });
        return;
      }
      await route.fallback();
    },
  );
  return mock;
}

async function expectInsideViewport(scope: Locator): Promise<void> {
  const width = await scope.page().evaluate(() => window.innerWidth);
  for (const control of await scope.getByRole("button").all()) {
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  }
}

const CELLS = [
  { name: "390x844", width: 390, height: 844, fontPx: null },
  { name: "320x568-200pct", width: 320, height: 568, fontPx: 32 },
] as const;

for (const { cell, theme, reducedMotion } of withAppearance(CELLS)) {
  test.describe(`segment library iphone ${cell.name}`, () => {
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

    test("Home lists the library as a fitted list with 44 px controls and removes a segment after asking", async ({
      page,
    }) => {
      const mock = await mockSegments(page, LIBRARY);
      await openHome(page);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      const section = page.getByRole("region", { name: "Segment library" });
      await expect(section).toBeVisible();
      const list = section.getByRole("list", { name: "Segment library" });
      await expect(list.getByRole("listitem")).toHaveCount(3);
      await expect(section.getByRole("table")).toHaveCount(0);
      await expect(section).toContainText("v3 · 3 versions");
      await expect(section).toContainText("Can't be played or inserted");
      await expect(section).toContainText("0:12");
      await expect(section).toContainText("0:35");
      await expectTouchTargets(section);
      await expectInsideViewport(section);
      await expectNoHorizontalScroll(page);
      await expectReadingSurfaceAxeClean(page);
      await shot(page, cell.name, theme, "segment-library-home");

      await section
        .getByRole("button", { name: "More actions for outro-77de" })
        .click();
      await page.getByRole("menuitem", { name: "Remove from library" }).click();
      const confirm = section.getByRole("group", { name: /Remove outro-77de/ });
      await expect(confirm).toContainText("every version");
      await expect(confirm).toContainText("can't be undone");
      await expect(confirm.getByRole("button", { name: "Keep" })).toBeFocused();
      await expectTouchTargets(section);
      await expectNoHorizontalScroll(page);
      await page.keyboard.press("Escape");
      await expect(confirm).toHaveCount(0);
      expect(mock.deletes).toEqual([]);

      await section
        .getByRole("button", { name: "More actions for outro-77de" })
        .click();
      await page.getByRole("menuitem", { name: "Remove from library" }).click();
      await confirm.getByRole("button", { name: "Remove" }).click();
      await expect(
        section.getByText("Removed outro-77de from the library."),
      ).toBeVisible();
      expect(mock.deletes).toEqual(["outro-77de"]);
      await expect(list.getByRole("listitem")).toHaveCount(2);
    });

    test("Play auditions one clip from the tap and Stop ends it", async ({
      page,
    }) => {
      const mock = await mockSegments(page, LIBRARY);
      await openHome(page);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      const section = page.getByRole("region", { name: "Segment library" });
      const play = section.getByRole("button", { name: "Play Cold open" });
      await play.click();
      await expect.poll(() => mock.audio.length).toBeGreaterThan(0);
      expect(mock.audio[0]).toMatch(/^intro-9f3a\?clip=0&version=1/);
      await expect(
        section.getByRole("button", { name: /^(Stop|Play) Cold open$/ }),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
    });

    test("Settings opens the Segment library sheet with the same rows", async ({
      page,
    }) => {
      await mockSegments(page, LIBRARY);
      await openHome(page);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      await chooseHomeMenuItem(page, "Settings");
      await page
        .getByRole("dialog", { name: "Settings" })
        .getByRole("button", { name: "Segment library" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Segment library" });
      await expect(dialog).toBeVisible();
      await expect(
        dialog
          .getByRole("list", { name: "Segment library" })
          .getByRole("listitem"),
      ).toHaveCount(3);
      await expectTouchTargets(dialog);
      await expectInsideViewport(dialog);
      await expectNoHorizontalScroll(page);
      await expectSurfaceAxeClean(page, '[role="dialog"]');
      await shot(page, cell.name, theme, "segment-library-sheet");
    });
  });
}

test.describe("segment library desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Home draws the library as a table with column headers", async ({
    page,
  }) => {
    await prepare(page, "light", true);
    await mockBootstrap(page);
    await mockSegments(page, LIBRARY);
    await openHome(page);
    const section = page.getByRole("region", { name: "Segment library" });
    const table = section.getByRole("table", { name: "Segment library" });
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader")).toHaveText([
      "Audition",
      "Name",
      "Type",
      "Length",
      "Actions",
    ]);
    await expect(table.getByRole("row")).toHaveCount(4);
    await expectTouchTargets(section);
    await expectNoHorizontalScroll(page);
    await expectReadingSurfaceAxeClean(page);
    await shot(page, "1440x900", "light", "segment-library-home");
  });
});
