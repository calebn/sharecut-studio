import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
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
 * the value between interactions.
 */
export function useArgState<T>(arg: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(arg);
  useEffect(() => {
    setValue(arg);
  }, [arg]);
  return [value, setValue];
}
