import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRegisteredCommands, execute } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawKeymapListener } from "../../keymap/listener";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import { CreateMenu } from "./CreateMenu";
import { createMenuRows } from "./createMenuRows";

vi.mock("../../commands/execute", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../commands/execute")>();
  return { ...actual, execute: vi.fn(actual.execute) };
});

function KeymapHost({ open, onClose }: { open: boolean; onClose: () => void }) {
  useDawKeymapListener();
  return open ? (
    <CreateMenu
      rows={createMenuRows({
        lane: true,
        envelopeShown: true,
        clipboardHasAudio: false,
      })}
      time="12:04.3"
      track="Maya"
      anchor={{ x: 300, y: 300 }}
      bounds={{ left: 0, top: 0, right: 600, bottom: 400 }}
      onPick={() => undefined}
      onClose={onClose}
    />
  ) : (
    <div data-testid="canvas">Timeline canvas</div>
  );
}

beforeEach(() => {
  vi.mocked(execute).mockClear();
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().hydrate("/tmp/create-menu-project", minimalProject());
  useDawStore.setState({ selection: { kind: "chapter", id: "c1", time: 1 } });
});

afterEach(() => {
  useDawStore.setState({ selection: null, stage: "edit" });
  clearRegisteredCommands();
});

it("closes on Escape without the keymap also clearing the selection", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  // Mount the keymap first, then open the menu: the keymap's window listener
  // is then registered before the menu's own, so the menu cannot swallow
  // Escape ahead of it; the keymap's own gates (`overlayOpen`, with
  // `keymapHandoff` behind it) are what hold it.
  const { rerender } = render(<KeymapHost open={false} onClose={onClose} />);
  rerender(<KeymapHost open onClose={onClose} />);
  await waitFor(() => expect(screen.getAllByRole("menuitem")[0]).toHaveFocus());
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(vi.mocked(execute)).not.toHaveBeenCalled();
  expect(useDawStore.getState().selection).not.toBeNull();

  // The menu gone, the same key reaches the keymap and clears the selection.
  rerender(<KeymapHost open={false} onClose={onClose} />);
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(vi.mocked(execute)).toHaveBeenCalledWith(
      "edit.clearSelection",
      expect.anything(),
      expect.anything(),
    ),
  );
});

it("holds every other key from the keymap while it is open, and lets them through once closed", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<KeymapHost open onClose={() => undefined} />);
  await waitFor(() => expect(screen.getAllByRole("menuitem")[0]).toHaveFocus());
  await user.keyboard("{ArrowDown}{ArrowUp}{Home}{End}k");
  expect(vi.mocked(execute)).not.toHaveBeenCalled();

  rerender(<KeymapHost open={false} onClose={() => undefined} />);
  await user.keyboard("k");
  await waitFor(() => expect(vi.mocked(execute)).toHaveBeenCalled());
});
