import { act, render, renderHook, screen } from "@testing-library/react";
import { userEvent } from "storybook/test";
import { describe, expect, it, vi } from "vitest";
import { DialogLauncher } from "./DialogLauncher";
import { openDialogByLauncher, useArgState } from "./storyDialog";

describe("openDialogByLauncher", () => {
  it("clicks the launcher when no dialog is open, then finds it by name", async () => {
    const { container } = render(
      <DialogLauncher label="Open sample" initiallyOpen={false}>
        {(open, close) =>
          open ? (
            <div role="dialog" aria-label="Sample">
              <button type="button" onClick={close}>
                Close
              </button>
            </div>
          ) : null
        }
      </DialogLauncher>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();

    const dialog = await openDialogByLauncher(container, {
      launcherName: "Open sample",
      dialogName: "Sample",
    });
    expect(dialog).toHaveAttribute("aria-label", "Sample");

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("returns an already-open dialog without clicking the launcher", async () => {
    const spy = vi.fn();
    const { container } = render(
      <>
        <button type="button" onClick={spy}>
          Open sample
        </button>
        <div role="dialog" aria-label="Sample" />
      </>,
    );

    const dialog = await openDialogByLauncher(container, {
      launcherName: "Open sample",
      dialogName: "Sample",
    });
    expect(dialog).toHaveAttribute("aria-label", "Sample");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("useArgState", () => {
  it("re-syncs from the arg only when the arg itself changes", () => {
    const { result, rerender } = renderHook(
      ({ arg }: { arg: number }) => useArgState(arg),
      { initialProps: { arg: 1 } },
    );
    expect(result.current[0]).toBe(1);

    act(() => {
      result.current[1](5);
    });
    expect(result.current[0]).toBe(5);

    rerender({ arg: 2 });
    expect(result.current[0]).toBe(2);

    act(() => {
      result.current[1](7);
    });
    rerender({ arg: 2 });
    expect(result.current[0]).toBe(7);
  });
});
