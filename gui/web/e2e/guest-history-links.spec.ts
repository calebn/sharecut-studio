import { expect, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { expectFeedback } from "./feedback";
import { hostList, SIZES, withGuestLinks, withGuestPage } from "./guestLink";
import { openGuestShare } from "./shareNavigation";
import { goToStage } from "./stageNav";

/**
 * An Editor's Undo and Redo move the Editor's own steps and never take a
 * review link away: every link opens the episode after each press, the
 * host's list of links is unchanged, no answer is a server error, and a press
 * with nothing of the Editor's to move to is not sent, says so in words and
 * does not read as a failed save or a conflict.
 */

const [, DESKTOP] = SIZES;
const MOVES = { U: "Control+z", R: "Control+Shift+z" } as const;
const NOTHING = {
  U: "There is nothing of yours to undo.",
  R: "There is nothing of yours to redo.",
} as const;
const OWN_STEPS = 2;
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
        for (let n = 1; n <= OWN_STEPS; n += 1) {
          const own = await guest.request.post(
            `/api/review/${links.editor}/daw/document/command`,
            {
              data: {
                type: "AddChapter",
                payload: { time: n * 4, title: `Own ${n}` },
                client_id: "e2e-own-steps",
                client_seq: n,
                role: "guest",
              },
            },
          );
          expect(own.ok(), await own.text()).toBe(true);
          await expect(guest.getByLabel(`Chapter Own ${n}`)).toBeVisible();
        }
        const attention = guest.getByRole("group", {
          name: /^Needs attention/,
        });
        let sent = 0;
        guest.on("request", (request) => {
          if (
            request.method() === "POST" &&
            request.url().endsWith("/daw/document/command") &&
            /^(Undo|Redo)History$/.test(request.postDataJSON()?.type)
          )
            sent += 1;
        });
        let done = OWN_STEPS;
        let pressed = "";
        await guest
          .locator(".timeline-scroll")
          .click({ position: { x: 4, y: 4 } });
        await guest.keyboard.press("Escape");
        for (const move of order) {
          pressed += move;
          const allowed = move === "U" ? done > 0 : done < OWN_STEPS;
          const before = sent;
          if (allowed) {
            const answered = guest.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                response.url().endsWith("/daw/document/command"),
            );
            await guest.keyboard.press(MOVES[move]);
            expect((await answered).status(), `${pressed}: the answer`).toBe(
              200,
            );
            done += move === "U" ? -1 : 1;
            const header = {
              U: guest.locator('button[aria-label="Undo"]'),
              R: guest.locator('button[aria-label="Redo"]'),
            };
            if (done > 0) await expect(header.U).toBeEnabled();
            else await expect(header.U).toBeDisabled();
            if (done < OWN_STEPS) await expect(header.R).toBeEnabled();
            else await expect(header.R).toBeDisabled();
          } else {
            await guest.keyboard.press(MOVES[move]);
            await expectFeedback(guest, NOTHING[move]);
            expect(sent, `${pressed}: nothing was sent`).toBe(before);
          }
          await expectEveryLinkOpens(host, links, pressed);
          await expect(guest.getByText("Save failed")).toHaveCount(0);
          await expect(attention).toHaveCount(0);
          expect(
            await listState(host, projectPath),
            `${pressed}: the list`,
          ).toEqual(listed);
        }
        expect(serverErrors).toEqual([]);
        await goToStage(guest, "review");
        await expect(attention).toHaveCount(0);
        await expect(guest.locator(".stage-frame--guest")).toBeVisible();
      });
    });
  });
}
