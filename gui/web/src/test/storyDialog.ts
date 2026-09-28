import { type Dispatch, type SetStateAction, useState } from "react";
import { userEvent, within } from "storybook/test";

/**
 * Story play helper: return the open dialog named `dialogName`, first
 * clicking the `launcherName` button when that dialog is not already open.
 * An unrelated open dialog does not suppress the click. Autodocs previews
 * start closed; standalone Canvas stories start open.
 */
export async function openDialogByLauncher(
  canvasElement: HTMLElement,
  { launcherName, dialogName }: { launcherName: string; dialogName: string },
): Promise<HTMLElement> {
  if (!within(document.body).queryByRole("dialog", { name: dialogName })) {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: launcherName }),
    );
  }
  return within(document.body).findByRole("dialog", { name: dialogName });
}

/**
 * Local story state seeded from an arg that re-syncs whenever the arg
 * changes, so Storybook Controls keep driving a preview that also owns
 * the value between interactions. Controls win on purpose: editing an arg
 * replaces any local change the preview made to that value (for example a
 * revoked share row). Play functions keep args fixed, so they never hit this.
 */
export function useArgState<T>(arg: T): [T, Dispatch<SetStateAction<T>>] {
  const [prevArg, setPrevArg] = useState(arg);
  const [value, setValue] = useState(arg);
  if (!Object.is(prevArg, arg)) {
    setPrevArg(arg);
    setValue(arg);
  }
  return [value, setValue];
}
