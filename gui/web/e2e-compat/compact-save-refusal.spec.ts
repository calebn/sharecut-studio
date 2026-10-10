import { expect, type Locator } from "@playwright/test";
import {
  compactHistory,
  edited,
  openAt,
  original,
  receipt,
  SIZES,
  savedEnvelope,
  test,
} from "../e2e/compactChromeFixture";
import { newFinger } from "../e2e/finger";

import { centerOf, lane, watchCommands } from "../e2e/touchTimeline";

test.use({ hasTouch: true });
test.describe.configure({ timeout: 240_000 });

for (const pending of ["wait", "refuse"] as const) {
  test.describe(`pending save ${pending}`, () => {
    test("compact header handles Undo while a save is pending", async ({
      page,
      context,
      browserName,
    }, info) => {
      await openAt(page, SIZES.landscape);
      const finger = await newFinger(context, page, browserName);
      const at = await centerOf(page, `${lane} [data-hit-id="env-c"]`);
      await finger.down(at);
      await page.waitForTimeout(60);
      await finger.up();
      await expect(page.locator(".bottom-sheet--compact")).toBeVisible();
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "32px";
      });
      await page.waitForTimeout(600);
      let releaseSave = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      await page.route("**/api/document/command*", async (route) => {
        const body = route.request().postDataJSON() as { type: string };
        if (body.type === "SetEnvelope") await gate;
        await route.continue();
      });
      const commands = watchCommands(page);
      const tap = async (button: Locator) => {
        const box = await button.boundingBox();
        if (!box) throw new Error("Button has no box");
        await finger.down({
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        });
        await page.waitForTimeout(60);
        await finger.up();
      };
      try {
        await tap(
          page.getByRole("button", {
            name: "Envelope point 0.01 s later",
            exact: true,
          }),
        );
        await expect
          .poll(() => commands.map((command) => command.type))
          .toEqual(["SetEnvelope"]);
        await tap(
          compactHistory(page).getByRole("button", {
            name: "Undo",
            exact: true,
          }),
        );
        await page.waitForTimeout(200);
        expect(commands.map((command) => command.type)).toEqual([
          "SetEnvelope",
        ]);
        await expect.poll(() => savedEnvelope(page)).toEqual(original);
        if (pending === "refuse") {
          await expect(page.locator(".ui-toast-region--app")).toContainText(
            "Your last edit is still saving. Nothing was undone.",
            { timeout: 7000 },
          );
          expect(commands.map((command) => command.type)).toEqual([
            "SetEnvelope",
          ]);
        }
        releaseSave();
        if (pending === "wait") {
          await expect
            .poll(() => commands.map((command) => command.type))
            .toEqual(["SetEnvelope", "UndoHistory"]);
          await expect.poll(() => savedEnvelope(page)).toEqual(original);
        } else {
          await expect.poll(() => savedEnvelope(page)).toEqual(edited);
          expect(commands.map((command) => command.type)).toEqual([
            "SetEnvelope",
          ]);
        }
        await receipt(info, `pending-save-${pending}-${browserName}`, {
          commands,
          saved: await savedEnvelope(page),
        });
      } finally {
        releaseSave();
        await page.unrouteAll({ behavior: "wait" });
      }
    });
  });
}
