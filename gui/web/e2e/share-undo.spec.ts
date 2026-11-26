import path from "node:path";
import {
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectFeedback } from "./feedback";
import { hostList } from "./guestLink";
import { createRecordRoom } from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { createReviewShare, openGuestShare } from "./shareNavigation";
import { goToStage, openProject, openProjectDialog } from "./stageNav";

/*
 * Stop sharing and End room (when nothing can be lost) act at once and leave a
 * toast whose Undo the server honors for its window (10 s). Everything here goes through the built
 * app and the real host server: the guest URL is dead after the stop, live
 * again after Undo.
 */

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const PROOF_DIR = process.env.UI_PROOF_DIR;

async function proof(page: Page, name: string): Promise<void> {
  if (PROOF_DIR) await page.screenshot({ path: path.join(PROOF_DIR, name) });
}

/** What a guest holding `token` gets: 200 while the link is live, 404 once it is stopped. */
async function guestStatus(page: Page, token: string): Promise<number> {
  const res = await page.request.get(`/api/review/${token}/project`);
  return res.status();
}

async function usable(page: Page, projectPath: string) {
  return (await hostList(page, projectPath)).filter((row) => row.usable);
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

        await expectFeedback(page, "Link stopped.");
        await expect(sheet.getByRole("dialog")).toHaveCount(0);
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
      const undo = toast(page).getByRole("button", { name: "Undo" });
      await undo.focus();
      await undo.hover();
      await expect(toast(page)).toBeHidden({ timeout: 12_000 });
      await expect(
        sheet.getByRole("heading", { name: "Review links" }),
      ).toBeFocused();
      // The toast leaves 500 ms before the server's window closes; wait the window out.
      await expect
        .poll(() => Date.now() >= stoppedAt + 10_500, {
          timeout: 12_000,
          intervals: [100],
        })
        .toBe(true);
      expect(await guestStatus(page, token)).toBe(404);
      const res = await page.request.post(
        `/api/shares/${encodeURIComponent(token)}/restore`,
        { data: { path: projectPath } },
      );
      expect(res.status()).toBe(410);
      expect(await usable(page, projectPath)).toEqual([]);
    });
  });

  test("copy and a second stop leave the original Undo, which can retry a failed request", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      const stopped = await createReviewShare(page, projectPath, "viewer");
      const other = await createReviewShare(page, projectPath, "commenter");
      const sheet = await openInvite(page, projectPath);
      const review = sheet.getByRole("heading", { name: "Review links" });
      const stop = async (role: string) => {
        await sheet
          .getByRole("button", { name: `More for ${role} link` })
          .click();
        await page.getByRole("menuitem", { name: "Stop sharing" }).click();
      };
      await stop("Viewer");
      await expectFeedback(page, "Link stopped.");
      await expect(review).toBeFocused();
      await sheet.getByRole("button", { name: "Copy Commenter link" }).click();
      await expect(
        sheet.getByText("Link copied", { exact: true }),
      ).toBeVisible();
      await expect(toast(page)).toContainText("Link stopped.");
      await stop("Commenter");
      await expect(sheet.getByText("Undo is still available.")).toBeVisible();
      expect(await guestStatus(page, stopped)).toBe(404);
      expect(await guestStatus(page, other)).toBe(200);

      await page.route(
        `**/api/shares/${stopped}/restore`,
        (route) => route.abort(),
        { times: 1 },
      );
      const undo = toast(page).getByRole("button", { name: "Undo" });
      await undo.click();
      await expect(toast(page)).toContainText("Undo failed");
      await expect(undo).toBeEnabled();
      await undo.click();
      await expectFeedback(page, "Link restored.");
      await expect(review).toBeFocused();
      expect(await guestStatus(page, stopped)).toBe(200);
      expect(await guestStatus(page, other)).toBe(200);
    });
  });

  test("closing Invite during a stop leaves the same project's Undo available", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      const token = await createReviewShare(page, projectPath, "viewer");
      const sheet = await openInvite(page, projectPath);
      let signalHeld = () => {};
      const held = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      let release = () => {};
      const waitForClose = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(
        `**/api/shares/${token}/revoke`,
        async (route) => {
          signalHeld();
          await waitForClose;
          await route.continue();
        },
        { times: 1 },
      );
      try {
        await sheet
          .getByRole("button", { name: "More for Viewer link" })
          .click();
        await page.getByRole("menuitem", { name: "Stop sharing" }).click();
        await held;
        await sheet.getByRole("button", { name: "Close", exact: true }).click();
        await expect(sheet).toBeHidden();
      } finally {
        release();
      }
      await expectFeedback(page, "Link stopped.");
      expect(await guestStatus(page, token)).toBe(404);
      await toast(page).getByRole("button", { name: "Undo" }).click();
      await expectFeedback(page, "Link restored.");
      expect(await guestStatus(page, token)).toBe(200);
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

  test("reopening Invite keeps the same share Undo in the keyboard cycle", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      const stopped = await createReviewShare(page, projectPath, "commenter");
      const other = await createReviewShare(page, projectPath, "editor");
      const sheet = await openInvite(page, projectPath);
      await sheet
        .getByRole("button", { name: "More for Commenter link" })
        .click();
      await page.getByRole("menuitem", { name: "Stop sharing" }).click();
      await expectFeedback(page, "Link stopped.");
      await sheet.getByRole("button", { name: "Close", exact: true }).click();
      await expect(sheet).toBeHidden();
      await openProjectDialog(page, "palette");
      const palette = page.getByRole("dialog", {
        name: "Commands and shortcuts",
      });
      await expect(palette).toBeVisible();
      await expect(
        page.locator('section[aria-label="Status messages"][inert] .ui-toast'),
      ).toContainText("Link stopped.");
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden();
      await openProjectDialog(page, "share");
      await expect(sheet).toBeVisible();

      await sheet.getByRole("button", { name: "More for Editor link" }).click();
      await page.getByRole("menuitem", { name: "Stop sharing" }).click();
      await expect(sheet.getByText("Undo is still available.")).toBeVisible();
      const undo = toast(page).getByRole("button", { name: "Undo" });
      expect(await guestStatus(page, stopped)).toBe(404);
      expect(await guestStatus(page, other)).toBe(200);
      await expect(undo).toBeVisible({ timeout: 2_000 });
      for (let presses = 0; presses < 40; presses += 1) {
        await page.keyboard.press("Tab");
        if (await undo.evaluate((el) => el === document.activeElement)) break;
      }
      await expect(undo).toBeFocused({ timeout: 2_000 });
      await page.keyboard.press("Enter");
      await expectFeedback(page, "Link restored.");
      await expect(
        sheet.getByRole("heading", { name: "Review links" }),
      ).toBeFocused();
      expect(await guestStatus(page, stopped)).toBe(200);
    });
  });

  test("End room on an idle room ends it at once, and Undo brings the room back", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      const room = await createRecordRoom(page, projectPath);
      const sheet = await openInvite(page, projectPath);
      const live = async () =>
        (await usable(page, projectPath)).map((r) => r.session_id);
      expect(await live()).toContain(room.session_id);

      await expect(
        sheet.getByRole("button", { name: "End room" }),
      ).toBeEnabled();
      await sheet.getByRole("button", { name: "End room" }).click();
      await expectFeedback(page, "Room ended.");
      await expect(sheet.getByRole("dialog")).toHaveCount(0);
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
