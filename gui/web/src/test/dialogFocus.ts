import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/**
 * `useDialogModal` moves focus into the panel one animation frame after the
 * dialog opens. A test that focuses a field and types before that frame lands
 * races it: the late initial focus takes the caret away and the keystrokes
 * are lost. Await this right after opening, before touching any field.
 */
export async function waitForDialogFocus(
  dialog: HTMLElement = screen.getByRole("dialog"),
): Promise<void> {
  await waitFor(() => {
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
}
