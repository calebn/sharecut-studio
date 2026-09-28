import { userEvent, within } from "storybook/test";

/**
 * Story play step for dialogs previewed behind a launcher button. Standalone
 * Canvas stories render the dialog open; autodocs examples start closed. Clicks
 * the launcher only when the named dialog is not already open, then returns it
 * (portaled into `document.body`).
 */
export async function openDialogViaLauncher(
  canvasElement: HTMLElement,
  launcherName: string,
  dialogName: string,
): Promise<HTMLElement> {
  if (!within(document.body).queryByRole("dialog", { name: dialogName })) {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: launcherName }),
    );
  }
  return within(document.body).getByRole("dialog", { name: dialogName });
}
