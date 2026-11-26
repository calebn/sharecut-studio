import { expect, type Locator, type Page, test } from "@playwright/test";
import { COPY_FAILED_MESSAGE } from "../src/stage/dialogs/hostMcp";
import { openDialogFromMenu, openHostProject } from "./overlayReachability";

/**
 * Connect agent dialog (DLG-MCP): the footer buttons hold the 44 px floor on a mouse too,
 * focus opens on Copy URL, the copy status clears with the "Copied" label, and a copy the
 * browser refuses says one plain thing that fits a phone. Vitest cannot measure layout.
 */
const FLOOR_PX = 44 - 0.5;

const SHELLS = [
  { name: "desktop 1280x800", width: 1280, height: 800, touch: false },
  { name: "iPhone 390x844 touch", width: 390, height: 844, touch: true },
] as const;

const WINDOW_MS = 2000;

type Box = { x: number; y: number; width: number; height: number };

/** The footer row and the snippet textarea: the two boxes a status change must not move. */
async function layoutBoxes(dialog: Locator) {
  const footer = await dialog.locator(".share-dialog-actions").boundingBox();
  const textarea = await dialog.getByLabel("Cursor snippet").boundingBox();
  return { footer: footer as Box, textarea: textarea as Box };
}

/** The dialog slides in; measure only once two reads in a row agree, so the open motion is not a "move". */
async function settledLayoutBoxes(dialog: Locator) {
  let last = JSON.stringify(await layoutBoxes(dialog));
  await expect
    .poll(async () => {
      const now = JSON.stringify(await layoutBoxes(dialog));
      const stable = now === last;
      last = now;
      return stable;
    })
    .toBe(true);
  return layoutBoxes(dialog);
}

function expectSameBox(actual: Box, expected: Box, label: string) {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(
      Math.abs(actual[key] - expected[key]),
      `${label}.${key}`,
    ).toBeLessThanOrEqual(1);
  }
}

async function openConnectAgent(page: Page) {
  await openHostProject(page);
  await openDialogFromMenu(page, "Connect agent…");
  const dialog = page.getByRole("dialog", { name: "Connect agent" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Make the browser refuse every clipboard write, as a denied permission does. */
async function denyClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          Promise.reject(new DOMException("denied", "NotAllowedError")),
      },
    });
  });
}

test("a real mouse click leaves the whole URL and snippet selected", async ({
  page,
}) => {
  const dialog = await openConnectAgent(page);
  for (const label of ["MCP URL", "Cursor snippet"]) {
    await dialog.getByLabel(label).click();
    const selected = await dialog
      .getByLabel(label)
      .evaluate(
        (el: HTMLInputElement | HTMLTextAreaElement) =>
          el.selectionStart === 0 && el.selectionEnd === el.value.length,
      );
    expect(selected, label).toBe(true);
  }
});

for (const shell of SHELLS) {
  test.describe(`Connect agent: ${shell.name}`, () => {
    test.use({
      viewport: { width: shell.width, height: shell.height },
      isMobile: shell.touch,
      hasTouch: shell.touch,
      permissions: ["clipboard-read", "clipboard-write"],
    });

    test("footer buttons hold the 44 px floor and focus opens on Copy URL", async ({
      page,
    }) => {
      const dialog = await openConnectAgent(page);
      if (shell.touch) {
        expect(
          await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
        ).toBe(true);
      }
      for (const name of ["Copy snippet", "Copy URL"]) {
        const box = await dialog
          .getByRole("button", { name, exact: true })
          .boundingBox();
        expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(FLOOR_PX);
      }
      await expect(
        dialog.getByRole("button", { name: "Copy URL", exact: true }),
      ).toBeFocused();
    });

    test("copying says Copied, then the label and the status clear together", async ({
      page,
    }) => {
      const dialog = await openConnectAgent(page);
      const before = await settledLayoutBoxes(dialog);
      await dialog
        .getByRole("button", { name: "Copy URL", exact: true })
        .click();
      await expect(dialog.getByText("Copied MCP URL")).toBeVisible();
      await expect(dialog.getByRole("status")).toHaveText("Copied MCP URL");
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      const during = await layoutBoxes(dialog);
      expectSameBox(during.footer, before.footer, "footer");
      expectSameBox(during.textarea, before.textarea, "textarea");
      await expect(
        dialog.getByRole("button", { name: "Copied", exact: true }),
      ).toBeVisible();
      const url = await dialog.getByLabel("MCP URL").inputValue();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        url,
      );
      await expect(dialog.getByText("Copied MCP URL")).toBeHidden({
        timeout: 3500,
      });
      await expect(
        dialog.getByRole("button", { name: "Copy URL", exact: true }),
      ).toBeVisible();
      await expect(dialog.getByRole("status")).toHaveText("");
      const after = await layoutBoxes(dialog);
      expectSameBox(after.footer, before.footer, "footer after clear");
      expectSameBox(after.textarea, before.textarea, "textarea after clear");
    });

    test("a refused copy says one plain thing that fits the screen", async ({
      page,
    }) => {
      await denyClipboard(page);
      const dialog = await openConnectAgent(page);
      const before = await settledLayoutBoxes(dialog);
      const pressed = dialog.getByRole("button", {
        name: "Copy snippet",
        exact: true,
      });
      await pressed.click();
      const startedAt = Date.now();
      const message = dialog.getByText(COPY_FAILED_MESSAGE);
      await expect(message).toBeVisible();
      await expect(pressed).toBeFocused();
      await expect(dialog.getByRole("alert")).toHaveCount(1);
      await expect(dialog.getByRole("alert")).toHaveText(COPY_FAILED_MESSAGE);
      await expect(dialog.getByRole("status")).toHaveText("");
      expect(
        await dialog
          .getByRole("alert")
          .evaluate((el) => !el.closest("[aria-live], [role=status]")),
      ).toBe(true);
      const during = await layoutBoxes(dialog);
      expectSameBox(during.footer, before.footer, "footer");
      expectSameBox(during.textarea, before.textarea, "textarea");
      // The failure is not on the 2 s timer: still there once the window has passed.
      await expect
        .poll(
          async () =>
            Date.now() - startedAt > WINDOW_MS + 500 &&
            (await dialog.getByRole("alert").isVisible()),
          { timeout: WINDOW_MS + 3000 },
        )
        .toBe(true);
      await expect(dialog.getByRole("alert")).toHaveCount(1);
      await expect(dialog.getByText(/denied|NotAllowed/i)).toHaveCount(0);
      const box = (await message.boundingBox())!;
      const panel = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(panel.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
      expect(box.x + box.width).toBeLessThanOrEqual(shell.width);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      // The fields select on focus, so "select the text" works.
      await dialog.getByLabel("MCP URL").focus();
      expect(
        await dialog
          .getByLabel("MCP URL")
          .evaluate(
            (el: HTMLInputElement) =>
              el.selectionStart === 0 && el.selectionEnd === el.value.length,
          ),
      ).toBe(true);
    });
  });
}
