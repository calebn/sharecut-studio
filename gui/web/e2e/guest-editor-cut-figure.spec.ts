import { expect, type Page, test } from "@playwright/test";
import { withSharedProject } from "./guestLink";
import { openGuestShare } from "./shareNavigation";
import { deliverPage, goToStage } from "./stageNav";

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

const pill = (page: Page) => page.locator(".sys-player-cuts");
const savedRow = (page: Page) =>
  deliverPage(page).getByRole("listitem").filter({ hasText: "Edits saved" });

async function savedText(page: Page): Promise<string> {
  await goToStage(page, "deliver");
  await expect(savedRow(page)).toBeVisible();
  const text = (await savedRow(page).innerText()).replace(/\s+/g, " ");
  return text;
}

test("a guest Editor's cut shows the same length figure as the host on the Player and in Deliver", async ({
  browser,
}) => {
  await withSharedProject(
    browser,
    [PHONE, PHONE],
    ["editor", "viewer"],
    async ([host, editor, viewer], links, projectPath) => {
      await openGuestShare(editor!, links.editor!);
      await openGuestShare(viewer!, links.viewer!);

      for (const page of [host!, editor!, viewer!])
        await expect(pill(page)).toHaveCount(0);
      await goToStage(host!, "deliver");
      await expect(savedRow(host!)).toContainText("No cuts yet");
      await goToStage(host!, "edit");

      await editor!.getByRole("button", { name: "Dismiss hint" }).tap();
      await editor!
        .getByRole("group", { name: "Edit surface" })
        .getByRole("button", { name: "Script" })
        .tap();
      const words = editor!
        .getByRole("region", { name: "Script" })
        .locator('.sys-script-word[data-word-key^="reference:"]');
      await words.nth(2).tap();
      await words.nth(14).tap({ modifiers: ["Shift"] });
      const sent = editor!.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          /\/daw\/document\/command/.test(r.url()) &&
          r.request().postDataJSON()?.type === "EditSelectedRange",
      );
      await editor!
        .getByRole("group", { name: /^(Selection|Edit) actions$/ })
        .getByRole("button", { name: "Cut", exact: true })
        .tap();
      expect((await sent).status()).toBe(200);

      await expect(pill(host!)).toHaveText(/^−\d+:\d\d$/);
      const figure = (await pill(host!).innerText()).trim();
      await expect(pill(editor!)).toHaveText(figure);
      // The Viewer's page is a read-only script with no Player pill, so its
      // figure is read from the Viewer link's own episode read.
      const removed = async (url: string) =>
        (
          (await (await host!.request.get(url)).json()) as {
            edit_impact: { total_removed_sec: number };
          }
        ).edit_impact.total_removed_sec;
      const hostSec = await removed(
        `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
      );
      expect(hostSec).toBeGreaterThan(0.5);
      await viewer!.reload();
      await expect
        .poll(() => removed(`/api/review/${links.viewer}/daw/project`))
        .toBeCloseTo(hostSec, 3);

      // A guest's Deliver is
      // GuestDeliver (Files and Podcast listing): it has no "Edits saved" row.
      const hostRow = await savedText(host!);
      expect(hostRow).toMatch(/Edits saved .*\d.* shorter$/);
      expect(hostRow).not.toContain("No cuts yet");
      await goToStage(editor!, "deliver");
      await expect(savedRow(editor!)).toHaveCount(0);
      await expect(pill(editor!)).toHaveText(figure);
    },
  );
});
