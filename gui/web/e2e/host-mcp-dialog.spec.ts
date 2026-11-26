import { expect, type Page, test } from "@playwright/test";
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
      await dialog
        .getByRole("button", { name: "Copy URL", exact: true })
        .click();
      await expect(dialog.getByText("Copied MCP URL")).toBeVisible();
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
    });

    test("a refused copy says one plain thing that fits the screen", async ({
      page,
    }) => {
      await denyClipboard(page);
      const dialog = await openConnectAgent(page);
      await dialog
        .getByRole("button", { name: "Copy snippet", exact: true })
        .click();
      const message = dialog.getByText(COPY_FAILED_MESSAGE);
      await expect(message).toBeVisible();
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
