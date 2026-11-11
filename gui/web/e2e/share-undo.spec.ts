import path from "node:path";
import {
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectFeedback } from "./feedback";
import { createRecordRoom } from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { createReviewShare, openGuestShare } from "./shareNavigation";
import { goToStage, openProject, openProjectDialog } from "./stageNav";

/*
 * Stop sharing and End room act at once and leave a toast whose Undo the
 * server honors for its window (10 s). Everything here goes through the built
 * app and the real host server: the guest URL is dead after the stop, live
 * again after Undo.
 */

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

/** Where the proof screenshots go, when a run asks for them. */
const PROOF_DIR = process.env.UI_PROOF_DIR;

async function proof(page: Page, name: string): Promise<void> {
  if (PROOF_DIR) await page.screenshot({ path: path.join(PROOF_DIR, name) });
}

/** What a guest holding `token` gets: 200 while the link is live, 404 once it is stopped. */
async function guestStatus(page: Page, token: string): Promise<number> {
  const res = await page.request.get(`/api/review/${token}/daw/proxy/manifest`);
  return res.status();
}

type Row = { token: string; usable: boolean; session_id?: string | null };

async function usable(page: Page, projectPath: string): Promise<Row[]> {
  const res = await page.request.get(
    `/api/shares?path=${encodeURIComponent(projectPath)}`,
  );
  expect(res.ok(), await res.text()).toBeTruthy();
  const { shares } = (await res.json()) as { shares: Row[] };
  return shares.filter((row) => row.usable);
}

async function openInvite(page: Page, projectPath: string): Promise<Locator> {
  await openProject(page, projectPath);
  await goToStage(page, "edit");
  await openProjectDialog(page, "share");
  const sheet = page.getByRole("dialog", { name: "Invite" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Looking for your links…")).toBeHidden();
  return sheet;
}

const toast = (page: Page) => page.locator(".ui-toast-region--app .ui-toast");

/** A guest in a browser of their own opens the link, as a stranger would. */
async function guestOpens(browser: Browser, token: string): Promise<void> {
  const context = await browser.newContext();
  try {
    await openGuestShare(await context.newPage(), token);
  } finally {
    await context.close();
  }
}

function describeUndo(
  label: string,
  viewport: { width: number; height: number },
  touch: boolean,
  shots: { toast: string; undone: string },
): void {
  test.describe(label, () => {
    test.use({ viewport, hasTouch: touch, isMobile: touch });

    test("Stop sharing kills the link at once, and Undo brings the same link back", async ({
      page,
      browser,
    }) => {
      await withShareableProject(async (projectPath) => {
        await openProject(page, projectPath);
        const token = await createReviewShare(page, projectPath, "commenter");
        expect(await guestStatus(page, token)).toBe(200);
        const nativeDialogs: string[] = [];
        page.on("dialog", (native) => {
          nativeDialogs.push(native.message());
          void native.dismiss();
        });

        const sheet = await openInvite(page, projectPath);
        await sheet
          .getByRole("button", { name: "More for Commenter link" })
          .click();
        await page.getByRole("menuitem", { name: "Stop sharing" }).click();

        // No confirm first: the link is stopped and the toast carries Undo.
        await expectFeedback(page, "Link stopped.");
        await expect(
          sheet.getByRole("group", { name: /Stop sharing this/ }),
        ).toBeHidden();
        await expect(
          sheet.getByRole("button", { name: "More for Commenter link" }),
        ).toBeHidden();
        await expect
          .poll(() => guestStatus(page, token), { timeout: 5_000 })
          .toBe(404);
        expect(await usable(page, projectPath)).toEqual([]);
        await expect(
          sheet.getByRole("heading", { name: "Review links" }),
        ).toBeFocused();

        const undo = toast(page).getByRole("button", { name: "Undo" });
        await expect(undo).toBeVisible();
        const box = await toast(page).boundingBox();
        expect(box).toBeTruthy();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5);
        if (touch) {
          const height = await undo.evaluate((el) =>
            el instanceof HTMLElement ? el.offsetHeight : 0,
          );
          expect(height).toBeGreaterThanOrEqual(44);
        }
        await proof(page, shots.toast);

        if (touch) await undo.tap();
        else await undo.click();

        await expectFeedback(page, "Link restored.");
        await expect(
          sheet.getByRole("button", { name: "More for Commenter link" }),
        ).toBeVisible();
        await expect
          .poll(() => guestStatus(page, token), { timeout: 5_000 })
          .toBe(200);
        expect((await usable(page, projectPath)).map((r) => r.token)).toEqual([
          token,
        ]);
        await guestOpens(browser, token);
        await proof(page, shots.undone);
        expect(nativeDialogs).toEqual([]);
      });
    });
  });
}

describeUndo("desktop 1280x900", { width: 1280, height: 900 }, false, {
  toast: "desktop-toast.png",
  undone: "desktop-after-undo.png",
});

describeUndo("phone 390x844 touch", { width: 390, height: 844 }, true, {
  toast: "phone-toast.png",
  undone: "phone-after-undo.png",
});

test.describe("desktop 1280x900 beyond the happy path", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the link stays dead once the window has passed, and the toast has left by then", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      const token = await createReviewShare(page, projectPath, "viewer");
      const sheet = await openInvite(page, projectPath);
      await sheet.getByRole("button", { name: "More for Viewer link" }).click();
      await page.getByRole("menuitem", { name: "Stop sharing" }).click();
      const stoppedAt = Date.now();
      await expectFeedback(page, "Link stopped.");
      await expect(toast(page)).toBeHidden({ timeout: 12_000 });
      // The toast leaves 500 ms before the server's window closes; wait the window out.
      await page.waitForTimeout(Math.max(0, stoppedAt + 10_500 - Date.now()));
      expect(await guestStatus(page, token)).toBe(404);
      const res = await page.request.post(
        `/api/shares/${encodeURIComponent(token)}/restore`,
        { data: { path: projectPath } },
      );
      expect(res.status()).toBe(410);
      expect(await usable(page, projectPath)).toEqual([]);
    });
  });

  test("Undo is reachable by keyboard from the sheet: Tab walks on to the toast", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      const token = await createReviewShare(page, projectPath, "viewer");
      const sheet = await openInvite(page, projectPath);
      await sheet.getByRole("button", { name: "More for Viewer link" }).click();
      await page.getByRole("menuitem", { name: "Stop sharing" }).click();
      await expectFeedback(page, "Link stopped.");
      const undo = toast(page).getByRole("button", { name: "Undo" });
      let reached = false;
      for (let presses = 0; presses < 40 && !reached; presses += 1) {
        await page.keyboard.press("Tab");
        reached = await undo.evaluate((el) => el === document.activeElement);
      }
      expect(reached).toBe(true);
      await page.keyboard.press("Enter");
      await expectFeedback(page, "Link restored.");
      await expect
        .poll(() => guestStatus(page, token), { timeout: 5_000 })
        .toBe(200);
    });
  });

  test("End room ends the room at once, and Undo brings the room back", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      const room = await createRecordRoom(page, projectPath);
      const sheet = await openInvite(page, projectPath);
      const live = async () =>
        (await usable(page, projectPath)).map((r) => r.session_id);
      expect(await live()).toContain(room.session_id);

      await sheet.getByRole("button", { name: "End room" }).click();
      await expectFeedback(page, "Room ended.");
      await expect(
        sheet.getByRole("button", { name: "Keep room" }),
      ).toBeHidden();
      await expect(
        sheet.getByText("Record room", { exact: true }),
      ).toBeHidden();
      expect(await live()).toEqual([]);
      await expect(
        sheet.getByRole("heading", { name: "Record links" }),
      ).toBeFocused();

      await toast(page).getByRole("button", { name: "Undo" }).click();
      await expectFeedback(page, "Room restored.");
      await expect(
        sheet.getByText("Record room", { exact: true }),
      ).toBeVisible();
      expect(await live()).toContain(room.session_id);
    });
  });
});
