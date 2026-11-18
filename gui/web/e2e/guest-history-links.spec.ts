import { expect, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { hostList, SIZES, withGuestLinks, withGuestPage } from "./guestLink";
import { openGuestShare } from "./shareNavigation";
import { goToStage } from "./stageNav";

/**
 * An Editor's Undo and Redo move the episode's history and never take a
 * review link away: every link opens the episode after each press, the
 * host's list of links is unchanged, no answer is a server error, and a press
 * with nothing to move to says so in words and does not read as a failed save.
 */

const [, DESKTOP] = SIZES;
const MOVES = { U: "Control+z", R: "Control+Shift+z" } as const;
const NOTHING = {
  U: "There is nothing to undo.",
  R: "There is nothing to redo.",
} as const;
type Move = keyof typeof MOVES;

const WORDS = { U: "Undo", R: "Redo" } as const;

/** All sixteen orders of four presses; each press is checked, so shorter orders are covered too. */
const ORDERS: Move[][] = Array.from({ length: 16 }, (_, n) =>
  [3, 2, 1, 0].map((bit): Move => ((n >> bit) & 1 ? "R" : "U")),
);

type Links = { viewer: string; commenter: string; editor: string };

/** What the host's list says about each link, without the tokens. */
const listState = async (host: Page, projectPath: string) =>
  (await hostList(host, projectPath)).map(({ docs_role, usable }) => ({
    role: docs_role,
    usable,
  }));

async function expectEveryLinkOpens(host: Page, links: Links, where: string) {
  for (const [role, token] of Object.entries(links)) {
    const answer = await host.request.get(`/api/review/${token}/project`);
    expect(answer.status(), `${where}: the ${role} link`).toBe(200);
  }
}

for (const order of ORDERS) {
  test(`an Editor presses ${order.map((move) => WORDS[move]).join(", ")} and no link ends`, async ({
    browser,
  }) => {
    await withGuestLinks(browser, async (links, host, projectPath) => {
      await postDocumentCommand(
        host,
        "e2e-seed",
        "SplitAtTime",
        { at_time: 10 },
        projectPath,
      );
      const listed = await listState(host, projectPath);
      expect(listed).toHaveLength(3);
      await withGuestPage(browser, DESKTOP, async (guest) => {
        const serverErrors: string[] = [];
        guest.on("response", (response) => {
          if (response.status() >= 500) {
            serverErrors.push(
              `${response.status()} ${new URL(response.url()).pathname.replace(links.editor, "<token>")}`,
            );
          }
        });
        await openGuestShare(guest, links.editor);
        // The steps the host's history holds: how many Undo presses can land, however
        // many the fixture's own set-up recorded.
        const history = await host.request.get(
          `/api/document/comments?path=${encodeURIComponent(projectPath)}`,
        );
        const steps = (
          (await history.json()) as { history: { cursor: number } }
        ).history.cursor;
        expect(steps).toBeGreaterThan(0);
        let done = steps;
        const refused = new Set<string>();
        let pressed = "";
        for (const move of order) {
          pressed += move;
          const allowed = move === "U" ? done > 0 : done < steps;
          const answered = guest.waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              response.url().endsWith("/daw/document/command"),
          );
          await guest.keyboard.press(MOVES[move]);
          const answer = await answered;
          await expectEveryLinkOpens(host, links, pressed);
          expect(answer.status(), `${pressed}: the answer`).toBe(
            allowed ? 200 : 400,
          );
          if (allowed) {
            done += move === "U" ? -1 : 1;
          } else {
            refused.add(NOTHING[move]);
          }
          await expect(guest.getByText("Save failed")).toHaveCount(0);
          expect(
            await listState(host, projectPath),
            `${pressed}: the list`,
          ).toEqual(listed);
        }
        expect(serverErrors).toEqual([]);
        if (refused.size > 0) {
          await goToStage(guest, "review");
          const attention = guest.getByRole("group", {
            name: /^Needs attention/,
          });
          for (const sentence of refused) {
            await expect(attention, `the row says: ${sentence}`).toContainText(
              sentence,
            );
          }
          await expect(guest.getByText("Save failed")).toHaveCount(0);
        }
        await expect(guest.locator(".stage-frame--guest")).toBeVisible();
      });
    });
  });
}
