import { expect, type Page, test } from "@playwright/test";
import { isHitTestable } from "./actionBar";
import { expectSurfaceAxeClean } from "./axe";
import { expectFeedback } from "./feedback";
import { openHome } from "./home";
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

const segment = (
  id: string,
  name: string,
  kind: string,
  duration: number,
): Row => ({
  id,
  name,
  kind,
  version: 1,
  versions: [1],
  clips: [{ audio: `${id}.flac`, offset_sec: 0, duration_sec: duration }],
});

const SEGMENTS: Row[] = [
  segment("cold-open-1a2b3c4d", "Cold open", "intro", 12.4),
  segment("sign-off-4d2e0000", "Sign off", "outro", 20),
  segment("acme-read-21bc0000", "Acme sponsor read", "sponsor", 34.6),
  {
    id: "old-seg-77de0000",
    version: 2,
    damaged: true,
    problem: "Version 2 has no readable audio: clips/outro.flac is missing.",
    code: "segment_media_invalid",
  },
];

const SHOW_KIT: Row = {
  id: "show-kit-1a2b3c4d",
  name: "Show Kit",
  version: 2,
  versions: [1, 2],
  entries: 2,
  missing: 0,
  usable: true,
  problem: null,
};

type Mock = { lists: number; saves: unknown[] };

async function mockLibrary(
  page: Page,
  {
    segments = SEGMENTS,
    kits = [SHOW_KIT],
  }: { segments?: Row[]; kits?: Row[] },
): Promise<Mock> {
  const mock: Mock = { lists: 0, saves: [] };
  const saved: Row[] = [];
  await page.route(
    (url) => url.pathname === "/api/segments",
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ json: segments });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/kits",
    async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { name: string };
        mock.saves.push(body);
        saved.push({
          ...SHOW_KIT,
          id: "weekly-5c1d0000",
          name: body.name,
          version: 1,
          versions: [1],
          entries: 2,
        });
        await route.fulfill({
          json: { status: "added", id: "weekly-5c1d0000", version: 1 },
        });
        return;
      }
      mock.lists += 1;
      await route.fulfill({ json: [...kits, ...saved] });
    },
  );
  return mock;
}

for (const { cell, theme, reducedMotion } of withAppearance(CELLS)) {
  test.describe(`new kit phone ${cell.name}`, () => {
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

    async function openEditor(
      page: Page,
      options: { segments?: Row[]; kits?: Row[] } = {},
    ) {
      const mock = await mockLibrary(page, options);
      await openHome(page);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      const section = page.getByRole("region", { name: "Kits" });
      await expect(section).toBeVisible();
      const open = section.getByRole("button", { name: "New kit" });
      expect((await open.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
        43,
      );
      await open.tap();
      const dialog = page.getByRole("dialog", { name: "New kit" });
      await expect(dialog).toBeVisible();
      return { mock, section, dialog };
    }

    test("builds a kit from the library, saves it and marks the new row", async ({
      page,
    }) => {
      const { mock, section, dialog } = await openEditor(page);
      const picker = dialog.getByRole("list", { name: "Segments you can add" });
      await expect(picker.getByRole("listitem")).toHaveCount(3);
      await expect(dialog).toContainText(
        "1 segment can't be read and isn't listed.",
      );
      await dialog.getByRole("button", { name: "Add Cold open" }).tap();
      await dialog.getByRole("button", { name: "Add Sign off" }).tap();
      const entries = dialog
        .getByRole("list", { name: "Kit segments" })
        .getByRole("listitem");
      await expect(entries).toHaveCount(2);
      for (const item of await entries.all()) {
        expect((await item.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
          43,
        );
      }
      await dialog.getByRole("button", { name: "Move Sign off up" }).tap();
      await expect(entries.first()).toContainText("Sign off");
      await dialog.getByLabel("Name").fill("Weekly");
      await expect(dialog).toContainText("Saves a new kit.");
      await expectTouchTargets(dialog);
      await expectNoHorizontalScroll(page);
      await expectSurfaceAxeClean(page, "[role=dialog]");
      await shot(page, cell.name, theme, "kit-new-sheet");
      const save = dialog.getByRole("button", { name: "Save kit" });
      await expect(save).toBeEnabled();
      expect(await isHitTestable(save)).toBe(true);
      await save.tap();
      await expect(dialog).toHaveCount(0);
      expect(mock.saves).toEqual([
        {
          name: "Weekly",
          entries: [
            { segment_id: "sign-off-4d2e0000", at: "end" },
            { segment_id: "cold-open-1a2b3c4d", at: "start" },
          ],
        },
      ]);
      await expectFeedback(page, "Saved the kit Weekly with 2 segments.");
      const row = section.locator('[data-kit-row="weekly-5c1d0000"]');
      await expect(row).toHaveAttribute("data-new", "true");
      await expect(row).toBeFocused();
      await expectNoHorizontalScroll(page);
    });

    test("warns when a Start entry follows another Start entry", async ({
      page,
    }) => {
      const { dialog } = await openEditor(page);
      await dialog.getByRole("button", { name: "Add Cold open" }).tap();
      await dialog.getByRole("button", { name: "Add Cold open" }).tap();
      const note = dialog.getByText(/Start entries apply one after another/);
      await expect(note).toBeVisible();
      await expectNoHorizontalScroll(page);
      await dialog
        .getByRole("list", { name: "Kit segments" })
        .getByRole("listitem")
        .nth(1)
        .getByRole("radio", { name: "End" })
        .tap();
      await expect(note).toHaveCount(0);
    });

    test("asks for a name and keeps Save off until there is a segment", async ({
      page,
    }) => {
      const { mock, dialog } = await openEditor(page);
      const save = dialog.getByRole("button", { name: "Save kit" });
      await expect(save).toBeDisabled();
      await dialog.getByRole("button", { name: "Add Cold open" }).tap();
      await save.tap();
      await expect(dialog).toContainText("Enter a name for the kit.");
      expect(mock.saves).toEqual([]);
      await expectNoHorizontalScroll(page);
    });

    test("is on Home with no kits when a segment exists, and not when there is none", async ({
      page,
    }) => {
      const mock = await mockLibrary(page, { kits: [] });
      await openHome(page);
      await expect.poll(() => mock.lists).toBeGreaterThan(0);
      const section = page.getByRole("region", { name: "Kits" });
      await expect(section).toBeVisible();
      await expect(section).toContainText("No kits yet");
      await expect(
        section.getByRole("button", { name: "New kit" }),
      ).toBeVisible();
    });
  });
}

test.describe("new kit without segments", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("leaves the Kits section off Home when there are no segments and no kits", async ({
    page,
  }) => {
    await prepare(page, "light", true);
    await mockBootstrap(page);
    const mock = await mockLibrary(page, { segments: [], kits: [] });
    await openHome(page);
    await expect.poll(() => mock.lists).toBeGreaterThan(0);
    await expect(page.getByRole("region", { name: "Kits" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New kit" })).toHaveCount(0);
  });
});
