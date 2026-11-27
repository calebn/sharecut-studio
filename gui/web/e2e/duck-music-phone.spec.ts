import { expect, type Page, test } from "@playwright/test";
import { envelopeTrack } from "./envelopeCreationEvidence";
import { expectFeedback } from "./feedback";
import { expectNoHorizontalScroll, expectTouchTargets } from "./modelsMock";
import { openPhoneTimeline, rememberInspectorDetent } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { setTheme, type Theme, withAppearance } from "./theme";
import { trackHeaderButton } from "./trackHeader";

const CELLS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "320x740", width: 320, height: 740 },
] as const;

const READY = "Lowers 1 music track by 18 dB while people speak.";
const DUCK = "Duck music under speech";

function result(changed: boolean, earlierDips: number, dryRun: boolean) {
  return {
    plan_token: "plan-e2e",
    depth_db: -18,
    dialogue_track_ids: ["dialogue"],
    tracks: [
      {
        track_id: "t",
        changed,
        regions: 3,
        points: 12,
        replaced_generated: earlierDips,
        coarsened: false,
      },
    ],
    warnings: [],
    dry_run: dryRun,
    applied: !dryRun && changed,
  };
}

type Mocked = { commands: Record<string, unknown>[] };

/** Answer ApplyDucking from the page; every other document command reaches the host. */
async function mockDucking(page: Page, earlierDips: number): Promise<Mocked> {
  const mocked: Mocked = { commands: [] };
  await page.route(
    (url) => url.pathname === "/api/document/command",
    async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (body.type !== "ApplyDucking") {
        await route.fallback();
        return;
      }
      mocked.commands.push(body);
      const payload = body.payload as Record<string, unknown>;
      const dryRun = payload.dry_run === true;
      await route.fulfill({
        json: {
          ...(dryRun ? {} : { history_head_id: "hist_e2e_duck" }),
          command: {
            payload: { ...payload, result: result(true, earlierDips, dryRun) },
          },
        },
      });
    },
  );
  return mocked;
}

/** Opens the first track's phone Inspector and sets its Kind to Music, a real host edit on the disposable copy. */
async function openMusicInspector(
  page: Page,
  projectPath: string,
  theme: Theme,
) {
  await rememberInspectorDetent(page, "full");
  await openHostShare(page, projectPath);
  await setTheme(page, theme);
  await openPhoneTimeline(page);
  await trackHeaderButton(page, envelopeTrack(projectPath).label).tap();
  const dialog = page.getByRole("dialog", { name: "Inspector", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/\bsys-inspector--phone\b/);
  await expect(
    dialog.getByRole("button", { name: DUCK, exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("group", { name: "Kind", exact: true })
    .getByRole("button", { name: "Music", exact: true })
    .tap();
  return dialog;
}

for (const { cell, theme, reducedMotion } of withAppearance(CELLS)) {
  test.describe(`duck music iphone ${cell.name}`, () => {
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
    });

    test("a music track's phone inspector previews, then ducks the plan it showed, with an Undo toast", async ({
      page,
    }) => {
      await withShareableProject(async (projectPath) => {
        const mocked = await mockDucking(page, 0);
        const dialog = await openMusicInspector(page, projectPath, theme);
        const button = dialog.getByRole("button", { name: DUCK, exact: true });
        await button.scrollIntoViewIfNeeded();
        await expect(dialog.getByText(READY)).toBeVisible();
        await expect(button).toBeEnabled();
        await expectTouchTargets(dialog);
        await expectNoHorizontalScroll(page);
        expect(mocked.commands[0]).toMatchObject({
          type: "ApplyDucking",
          payload: { dry_run: true },
        });

        await button.tap();
        await expectFeedback(
          page,
          "Music now lowers under speech on 1 music track. Hear it once the mix refreshes, in play or export.",
        );
        await expect(
          page
            .locator(".ui-toast-region--app")
            .getByRole("button", { name: "Undo" }),
        ).toBeVisible();
        const apply = mocked.commands.find(
          (c) => (c.payload as Record<string, unknown>).dry_run !== true,
        );
        expect(apply).toMatchObject({
          type: "ApplyDucking",
          payload: { expected_plan_token: "plan-e2e" },
        });
        await expectNoHorizontalScroll(page);
      });
    });

    test("says ducking may be out of date when earlier dips would be replaced", async ({
      page,
    }) => {
      await withShareableProject(async (projectPath) => {
        await mockDucking(page, 4);
        const dialog = await openMusicInspector(page, projectPath, theme);
        await expect(
          dialog.getByText("Ducking may be out of date. Duck again."),
        ).toBeVisible();
        const again = dialog.getByRole("button", {
          name: "Duck again",
          exact: true,
        });
        await again.scrollIntoViewIfNeeded();
        await expect(again).toBeEnabled();
        await expectTouchTargets(dialog);
        await expectNoHorizontalScroll(page);
      });
    });
  });
}
