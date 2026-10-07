import { expect, test } from "@playwright/test";
import {
  postDocumentCommand,
  postHistoryMove,
  waiveRefineGate,
} from "./documentCommand";
import { e2eProjectPath } from "./env";
import { setTheme } from "./theme";

const CLIENT_ID = "e2e-edit-boundary-touch";

test.describe("Transcript edit-boundary touch drag", () => {
  test("a second finger on the boundary is ignored; one roll commits and the drag lock clears", async ({
    page,
    context,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const rolls: Array<{ delta_sec?: number }> = [];
    page.on("request", (req) => {
      if (
        req.url().includes("/api/document/command") &&
        req.method() === "POST"
      ) {
        const body = req.postDataJSON() as {
          type?: string;
          payload?: { delta_sec?: number };
        } | null;
        if (body?.type === "RollClipJoin") rolls.push(body.payload ?? {});
      }
    });
    // Specs share one live project: undo exactly what this spec applied.
    let applied = 0;
    try {
      await waiveRefineGate(page, "e2e edit boundary touch");
      await postDocumentCommand(page, CLIENT_ID, "CutRange", {
        mode: "ripple",
        confirm_cut_speech: true,
        start: 5,
        end: 15,
      });
      applied += 1;

      const panels = page.getByLabel("Editor panels");
      await panels
        .getByRole("button", { name: "Transcript", exact: true })
        .click();
      const annotate = panels.locator(".transcript-annotate-btn");
      await expect(annotate).toBeVisible();
      if ((await annotate.getAttribute("aria-pressed")) !== "true") {
        await annotate.click();
      }
      await expect(annotate).toHaveAttribute("aria-pressed", "true");

      const mark = page.locator(".edit-boundary-mark").first();
      await expect(mark).toBeVisible();
      await mark.scrollIntoViewIfNeeded();
      const box = await mark.boundingBox();
      expect(box).toBeTruthy();
      const x = box!.x + box!.width / 2;
      const y = box!.y + box!.height / 2;
      const first = { x, y, id: 1 };
      const thresholdMoved = { x: x + 8, y, id: 1 };
      const firstMoved = { x: x + 40, y, id: 1 };
      const second = { x: x + 4, y, id: 2 };

      await waiveRefineGate(page, "e2e edit boundary touch");
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 2,
      });
      const rolled = page.waitForResponse((res) => {
        if (!res.url().includes("/api/document/command")) return false;
        const body = res.request().postDataJSON() as { type?: string } | null;
        return body?.type === "RollClipJoin";
      });

      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [first],
      });
      await expect(mark).toHaveAttribute("aria-grabbed", "false");
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [thresholdMoved],
      });
      await expect(mark).toHaveAttribute("aria-grabbed", "true");
      // A second finger lands on the same boundary while the first drags.
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [first, second],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [firstMoved, second],
      });
      // Lifting the second finger must not end the first finger's drag.
      //
      // Empirically, Chromium's CDP touchEnd pairs the *released* contact
      // with the `touchPoints` entry given, the opposite of touchStart and
      // touchMove (whose arrays list every still-active contact): passing
      // `second` here ends the second finger's pointer and leaves the
      // first finger's drag running; passing the still-down contact
      // (`firstMoved`) ended the drag's own pointer instead.
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [second],
      });
      await expect(mark).toHaveAttribute("aria-grabbed", "true");
      await expect(page.locator("body")).toHaveClass(/is-boundary-dragging/);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });

      const response = await rolled;
      if (response.ok()) applied += 1;
      expect(response.ok()).toBe(true);
      await expect(page.locator("body")).not.toHaveClass(
        /is-boundary-dragging/,
      );
      expect(rolls).toHaveLength(1);
      expect(rolls[0]?.delta_sec ?? 0).toBeGreaterThan(0);
    } finally {
      for (let i = 0; i < applied; i += 1) {
        await postHistoryMove(page, CLIENT_ID, "UndoHistory");
      }
    }
  });
});

for (const width of [1440, 360]) {
  for (const theme of ["light", "dark"] as const) {
    test(`boundary grab point stays aligned through preview changes at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        /aligned dialogue/i,
      );
      await setTheme(page, theme);
      const boundaryCommands: string[] = [];
      page.on("request", (request) => {
        if (
          !request.url().includes("/api/document/command") ||
          request.method() !== "POST"
        )
          return;
        const command: { type?: string } | null = request.postDataJSON();
        if (
          command?.type === "RollClipJoin" ||
          command?.type === "TrimClipEdge"
        )
          boundaryCommands.push(command.type);
      });
      let applied = false;
      try {
        await waiveRefineGate(page, "e2e boundary geometry");
        await postDocumentCommand(page, CLIENT_ID, "CutRange", {
          mode: "ripple",
          confirm_cut_speech: true,
          start: 5,
          end: 15,
        });
        applied = true;
        await page
          .getByRole("button", {
            name: width < 720 ? "Text" : "Transcript",
            exact: true,
          })
          .click();
        const annotate = page.locator(".transcript-annotate-btn");
        if ((await annotate.getAttribute("aria-pressed")) !== "true")
          await annotate.click();
        const mark = page.locator(".edit-boundary-mark").first();
        await expect(mark).toBeVisible();
        await mark.scrollIntoViewIfNeeded();
        const initial = await mark.boundingBox();
        if (!initial) throw new Error("Boundary has no visible grab target");
        const x = initial.x + initial.width / 2;
        const y = initial.y + initial.height / 2;
        const paragraph = mark.locator(
          "xpath=ancestor::*[contains(@class, 'utterance-turn')][1]",
        );
        const originalParagraph = await paragraph.boundingBox();
        if (!originalParagraph)
          throw new Error("Boundary needs a visible transcript turn");
        await page.mouse.move(x, y);
        await page.mouse.down();
        for (const distance of [0, 4]) {
          await page.mouse.move(x + distance, y);
          const box = await mark.boundingBox();
          expect(box).toBeTruthy();
          expect(box!.x + box!.width / 2).toBeCloseTo(x, 0);
          await expect(page.locator(".edit-boundary-preview")).toHaveCount(0);
          await expect(mark).toHaveAttribute("aria-grabbed", "false");
        }
        for (const distance of [
          8, 16, 32, 64, 80, 32, 0, -4, -16, -32, -64, 0,
        ]) {
          await page.mouse.move(x + distance, y);
          await expect(async () => {
            const box = await mark.boundingBox();
            if (!box) throw new Error("Boundary disappeared during drag");
            expect(
              Math.abs(box.x + initial.width / 2 - (x + distance)),
            ).toBeLessThan(0.5);
            expect(Math.abs(box.y - initial.y)).toBeLessThan(0.5);
            expect(box.width).toBeCloseTo(initial.width, 1);
            expect(await paragraph.boundingBox()).toEqual(originalParagraph);
            const preview = await page
              .locator(".edit-boundary-preview")
              .boundingBox();
            if (!preview) throw new Error("Drag feedback disappeared");
            expect(preview.x).toBeGreaterThanOrEqual(0);
            expect(preview.x + preview.width).toBeLessThanOrEqual(width);
            expect(preview.y).toBeGreaterThanOrEqual(0);
            expect(preview.y + preview.height).toBeLessThanOrEqual(900);
            expect(
              preview.y >= initial.y + initial.height ||
                preview.y + preview.height <= initial.y,
            ).toBe(true);
          }).toPass({ timeout: 2000 });
        }
        await page.mouse.move(x + 10000, y);
        await expect(page.locator(".edit-boundary-preview")).toContainText(
          "Limit reached",
        );
        const preview = page.locator(".edit-boundary-preview");
        const limitedMessage = await preview.innerText();
        await page.mouse.move(x + 12000, y);
        await expect(async () => {
          const box = await mark.boundingBox();
          if (!box) throw new Error("Boundary disappeared at the limit");
          expect(Math.abs(box.x + box.width / 2 - (x + 12000))).toBeLessThan(
            0.5,
          );
          expect(await preview.innerText()).toBe(limitedMessage);
        }).toPass({ timeout: 2000 });
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await expect(page.locator("body")).not.toHaveClass(
          /is-boundary-dragging/,
        );
        await expect(mark).toHaveAttribute("aria-grabbed", "false");
        expect(boundaryCommands).toEqual([]);
      } finally {
        await page.mouse.up();
        if (applied) await postHistoryMove(page, CLIENT_ID, "UndoHistory");
      }
    });
  }
}
