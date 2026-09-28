import { expect, test } from "@playwright/test";
import { postDocumentCommand, waiveRefineGate } from "./documentCommand";
import { e2eProjectPath } from "./env";

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
      await postDocumentCommand(page, CLIENT_ID, "RippleDeleteRange", {
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
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [firstMoved],
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
        await postDocumentCommand(page, CLIENT_ID, "UndoHistory", {
          rerender: false,
        });
      }
    }
  });
});
