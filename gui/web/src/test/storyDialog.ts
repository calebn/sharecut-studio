import { type Dispatch, type SetStateAction, useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

const isRunning = (animation: Animation) =>
  animation.playState === "running" &&
  animation.effect?.getTiming().iterations !== Infinity;

/**
 * Story play helper: return the open dialog named `dialogName`, first
 * clicking the `launcherName` button when that dialog is not already open.
 * An unrelated open dialog does not suppress the click. Autodocs previews
 * start closed; standalone Canvas stories start open. Returns once the dialog
 * has finished fading in and focus is inside it: it takes its initial focus on
 * the next animation frame, and a play function that focuses a field sooner
 * would lose it to that move.
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
  const dialog = await within(document.body).findByRole("dialog", {
    name: dialogName,
  });
  await waitFor(() =>
    expect(dialog).toContainElement(document.activeElement as HTMLElement),
  );
  // A dialog fades in; text read at its first frame is still at zero opacity.
  if (typeof dialog.getAnimations === "function") {
    await waitFor(() =>
      expect(
        dialog.getAnimations({ subtree: true }).filter(isRunning),
      ).toHaveLength(0),
    );
  }
  return dialog;
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
