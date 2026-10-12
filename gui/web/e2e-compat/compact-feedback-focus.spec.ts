import { expect, type Page, type TestInfo } from "@playwright/test";
import {
  openAt,
  original,
  receipt,
  SIZES,
  savedEnvelope,
  test,
} from "../e2e/compactChromeFixture";
import { rememberInspectorDetent } from "../e2e/phoneTimeline";
import { lane } from "../e2e/touchTimeline";

test.use({ hasTouch: true, reducedMotion: "reduce" });
test("focused feedback Undo survives phone to tablet host remount", async ({
  page,
}, info) => {
  await checkRemount(page, info, "Undo");
});

test("focused feedback Dismiss survives phone to tablet host remount", async ({
  page,
}, info) => {
  await checkRemount(page, info, "Dismiss");
});

async function checkRemount(
  page: Page,
  info: TestInfo,
  name: "Undo" | "Dismiss",
) {
  await rememberInspectorDetent(page, "peek");
  await openAt(page, SIZES.portrait);
  await page
    .getByRole("button", {
      name: "Open track details, reference",
      exact: true,
    })
    .click();
  await expect(page.locator(".modifier-inspector")).toBeVisible();
  const close = page
    .locator(".bottom-sheet-header")
    .getByRole("button", { name: "Close", exact: true });
  await close.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".ui-toast-region--app .ui-toast")).toContainText(
    "Reordered track",
  );
  await close.click();
  const point = page.locator(`${lane} [data-hit-id="env-c"]`);
  await point.focus();
  await point.press("Enter");
  const panel = page.locator(".bottom-sheet--compact");
  await expect(panel).toBeVisible();
  await expect.poll(() => savedEnvelope(page)).toEqual(original);
  await panel
    .getByRole("button", { name: "Expand to half height", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Expand to full height", exact: true })
    .click();
  const card = page.locator(".ui-toast-region--app .ui-toast");
  const action = card.getByRole("button", { name, exact: true });
  await expect(action).toBeEnabled();
  await action.evaluate((element) =>
    element.setAttribute("data-native-focus-proof", "original-action"),
  );
  await action.focus();
  await expect(action).toBeFocused();
  await page.setViewportSize(SIZES.landscape);
  await expect(page.locator('.daw-shell[data-shell="tablet"]')).toBeVisible();
  await expect(panel).toBeVisible();
  await page.waitForTimeout(350);
  await receipt(info, `remount-${name}`, {
    nativeAction: await action.getAttribute("data-native-focus-proof"),
    focusedName: await page.locator(":focus").getAttribute("aria-label"),
  });
  await expect(action).toHaveAttribute(
    "data-native-focus-proof",
    "original-action",
  );
  await expect(action).toBeFocused();
}
