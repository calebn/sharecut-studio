import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { assertDisposableE2eProject, e2eProjectPath } from "./env";
import {
  expectServerWordsAbsent,
  failShell,
  MARKER_500,
  press,
  SIZES,
  withGuestLink,
} from "./guestLink";
import { waitForFrame } from "./stageNav";

/**
 * The studio's own load-failure cover: the first read of the episode fails
 * after the studio has opened. It says one fixed sentence chosen from the kind
 * of failure and never what the server answered, for a guest and for a host.
 */

const GUEST_TITLE = "The transcript didn't load";
const HOST_TITLE = "Could not load the project";
const GUEST_SERVER_SENTENCE =
  "Try again, and if it keeps happening, tell the person who sent it.";
const HOST_NAME = path.basename(path.dirname(e2eProjectPath));
const HOST_OTHER_SENTENCE = `ShareCut couldn't open "${HOST_NAME}". If a newer version of ShareCut saved it, update ShareCut first.`;

async function openHostWithoutProject(page: Page) {
  assertDisposableE2eProject(e2eProjectPath);
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await waitForFrame(page);
}

for (const size of SIZES) {
  test.describe(`a studio whose first read fails at ${size.width}x${size.height}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.touch,
    });

    test("a guest never reads the server's words on a 500, and Try again recovers", async ({
      browser,
    }) => {
      test.setTimeout(90_000);
      await withGuestLink(browser, size, async (guest, token) => {
        const shell = await failShell(guest, { token }, MARKER_500);
        await guest.goto(`/r/${token}`);
        const cover = guest.getByRole("alert");
        await expect(
          cover.getByRole("heading", { name: GUEST_TITLE }),
        ).toBeVisible();
        await expectServerWordsAbsent(guest);
        await expect(cover.locator(".sys-cover-text")).toHaveText(
          GUEST_SERVER_SENTENCE,
        );

        shell.lift();
        await press(
          cover.getByRole("button", { name: "Try again" }),
          size.touch,
        );
        await expect(cover).toBeHidden();
      });
    });

    test("a host never reads the server's words on a 500, and Try again recovers", async ({
      page,
    }) => {
      const shell = await failShell(page, "host", MARKER_500);
      await openHostWithoutProject(page);
      const cover = page.getByRole("alert");
      await expect(
        cover.getByRole("heading", { name: HOST_TITLE }),
      ).toBeVisible();
      await expectServerWordsAbsent(page);
      await expect(cover.locator(".sys-cover-text")).toHaveText(
        HOST_OTHER_SENTENCE,
      );

      shell.lift();
      await press(cover.getByRole("button", { name: "Try again" }), size.touch);
      await expect(cover).toBeHidden();
    });
  });
}
