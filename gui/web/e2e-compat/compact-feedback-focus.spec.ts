import { expect, type Page, type TestInfo } from "@playwright/test";
import {
  openAt,
  original,
  projectPath,
  receipt,
  SIZES,
  savedEnvelope,
  test,
} from "../e2e/compactChromeFixture";
import {
  openPhoneTimeline,
  rememberInspectorDetent,
} from "../e2e/phoneTimeline";
import { inspectSelectionByKey, openProject } from "../e2e/stageNav";
import { lane } from "../e2e/touchTimeline";

test.use({ hasTouch: true, reducedMotion: "reduce" });
test("focused feedback Undo survives a phone turning sideways", async ({
  page,
}, info) => {
  await checkRemount(page, info, "Undo");
});

test("focused feedback Dismiss survives a phone turning sideways", async ({
  page,
}, info) => {
  await checkRemount(page, info, "Dismiss");
});

test("focused feedback Undo stays in the column or its toast when a phone turns to 844x390", async ({
  page,
}, info) => {
  await checkColumnHandoff(page, info, "Undo");
});

test("focused feedback Dismiss stays in the column or its toast when a phone turns to 844x390", async ({
  page,
}, info) => {
  await checkColumnHandoff(page, info, "Dismiss");
});

test("an agent's selection and a peer's edit that remove the focused Undo hand focus to the sheet Close", async ({
  page,
  context,
}) => {
  const { action } = await focusCompactToastAction(page, "Undo");
  const peer = await context.newPage();
  await peer.setViewportSize(SIZES.portrait);
  await openProject(peer, projectPath);
  await openPhoneTimeline(peer);
  const selected = await peer.request.post(
    `/api/session/command?path=${encodeURIComponent(projectPath)}`,
    {
      data: {
        type: "SetSelection",
        payload: { selection: { kind: "track", track_id: "reference" } },
        client_id: "e2e-selection-agent",
        client_seq: 1,
        role: "agent",
      },
    },
  );
  expect(selected.ok(), await selected.text()).toBe(true);
  const sheet = page.locator(".bottom-sheet").filter({ hasText: "Track" });
  await expect(sheet.getByRole("group", { name: "Track mixer" })).toBeVisible();
  await expect(action).toBeFocused();

  await peer
    .getByRole("button", { name: "Open track details, reference", exact: true })
    .click();
  await peer
    .getByRole("group", { name: "Track mixer" })
    .getByRole("button", { name: /^Mute/ })
    .click();
  await expect(action).toHaveCount(0);
  await expect(
    sheet.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
});

async function focusCompactToastAction(page: Page, name: "Undo" | "Dismiss") {
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
  await inspectSelectionByKey(page);
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
  return { panel, action };
}

async function checkRemount(
  page: Page,
  info: TestInfo,
  name: "Undo" | "Dismiss",
) {
  const { panel, action } = await focusCompactToastAction(page, name);
  await page.setViewportSize(SIZES.landscape);
  await expect(page.locator(".stage-frame--phone")).toBeVisible();
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

/**
 * A phone that turns to 844x390 swaps its compact strip for the Inspector
 * column (#1696), which has no feedback host: the toast floats, and the
 * focused action it held hands focus to the column's Close, never to the page.
 */
async function checkColumnHandoff(
  page: Page,
  info: TestInfo,
  name: "Undo" | "Dismiss",
) {
  const { action } = await focusCompactToastAction(page, name);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator(".stage-frame--tablet")).toBeVisible();
  const column = page.locator(".bottom-sheet--column");
  await expect(column).toBeVisible();
  await receipt(info, `column-${name}`, {
    focusedName: await page.locator(":focus").getAttribute("aria-label"),
    focusedTag: await page.evaluate(() => document.activeElement?.tagName),
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!document.activeElement?.closest(
            ".bottom-sheet--column, .ui-toast-region--app",
          ),
      ),
    )
    .toBe(true);
  expect(await action.count()).toBeLessThanOrEqual(1);
}
