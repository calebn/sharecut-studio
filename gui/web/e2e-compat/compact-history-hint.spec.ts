import { expect } from "@playwright/test";
import { compactHistory, openAt, test } from "../e2e/compactChromeFixture";
import { lane } from "../e2e/touchTimeline";

test.use({ hasTouch: true, reducedMotion: "reduce" });

test("unavailable history feedback stays above a real inspector refusal", async ({
  page,
}, info) => {
  await openAt(page, { width: 390, height: 844 });
  const hit = page.locator(`${lane} [data-hit-id="env-c"]`);
  await hit.focus();
  await hit.press("Enter");
  const panel = page.locator(".bottom-sheet--compact");
  await expect(panel).toBeVisible();
  await page.locator("html").evaluate((html) => {
    html.style.fontSize = "32px";
  });
  await page.route("**/api/document/command*", async (route) => {
    const command = route.request().postDataJSON() as { type: string };
    if (command.type === "UndoHistory") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        headers: { "x-sharecut-error-code": "history_stale" },
        body: JSON.stringify({ detail: "Project changed" }),
      });
    } else await route.continue();
  });
  const controls = compactHistory(page);
  await controls.getByRole("button", { name: "Undo", exact: true }).click();
  const refusal = page.locator(
    ".ui-toast-region--inspector-flow .ui-toast-message",
  );
  await expect(refusal).toHaveText(
    "Can't undo: the project changed since. Nothing was undone.",
  );
  await panel.locator(".bottom-sheet-body").evaluate((body) => {
    body.scrollTop = 0;
  });
  const geometry = () =>
    panel.evaluate((sheet) =>
      [
        sheet,
        ...sheet.querySelectorAll(
          ".bottom-sheet-header,.bottom-sheet-body,.bottom-sheet-header button",
        ),
      ].map((node) => node.getBoundingClientRect().toJSON()),
    );
  const before = await geometry();
  await page.keyboard.press("Tab");
  const redo = controls.getByRole("button", { name: "Redo", exact: true });
  await expect(redo).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(controls.getByRole("status")).toHaveText("Nothing to redo");
  await expect(redo).toHaveAccessibleDescription("Nothing to redo");
  const feedback = await controls.getByRole("status").boundingBox();
  const body = await panel.locator(".bottom-sheet-body").boundingBox();
  expect(feedback).not.toBeNull();
  expect(body).not.toBeNull();
  expect(feedback!.y + feedback!.height).toBeLessThanOrEqual(body!.y);
  expect(await geometry()).toEqual(before);
  await info.attach("unavailable-history-refusal", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
