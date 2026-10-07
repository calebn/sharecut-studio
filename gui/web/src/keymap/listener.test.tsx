import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRegisteredCommands, execute } from "../commands/execute";
import { registerFocusedClipHandle } from "../commands/focusedClipHandle";
import { registerDawCommands } from "../commands/register";
import { AskDialog } from "../feedback/AskDialog";
import { askConfirm, askText } from "../feedback/ask";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { Dialog } from "../ui/Dialog";
import { useDawKeymapListener } from "./listener";

const actualExecute = (
  await vi.importActual<typeof import("../commands/execute")>(
    "../commands/execute",
  )
).execute;

vi.mock("../commands/execute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/execute")>();
  return { ...actual, execute: vi.fn(actual.execute) };
});

function KeymapHost() {
  useDawKeymapListener();
  return (
    <>
      <button type="button">Boundary button</button>
      <div data-testid="canvas">Timeline canvas</div>
    </>
  );
}

let disposeHandle: (() => void) | null = null;

beforeEach(() => {
  vi.mocked(execute).mockClear();
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().hydrate("/tmp/keymap-project", minimalProject());
});

afterEach(() => {
  vi.mocked(execute).mockImplementation(actualExecute);
  useDawStore.setState({ recordPanelOpen: false, selection: null });
  disposeHandle?.();
  disposeHandle = null;
  clearRegisteredCommands();
});

it("leaves Escape to an open modal dialog instead of also clearing the selection", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  useDawStore.setState({ selection: { kind: "chapter", id: "c1", time: 1 } });
  const { rerender } = render(
    <>
      <KeymapHost />
      <Dialog open title="Remove track?" onClose={onClose}>
        <p>Remove it?</p>
      </Dialog>
    </>,
  );
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(vi.mocked(execute)).not.toHaveBeenCalled();
  expect(useDawStore.getState().selection).not.toBeNull();

  rerender(
    <>
      <KeymapHost />
      <Dialog open={false} title="Remove track?" onClose={onClose}>
        <p>Remove it?</p>
      </Dialog>
    </>,
  );
  fireEvent.keyDown(screen.getByTestId("canvas"), { key: "Escape" });
  await waitFor(() =>
    expect(vi.mocked(execute)).toHaveBeenCalledWith(
      "edit.clearSelection",
      expect.anything(),
      expect.anything(),
    ),
  );
});

it("gives a focused button native Space activation but keeps canvas Space for transport", async () => {
  const user = userEvent.setup();
  render(<KeymapHost />);
  const button = screen.getByRole("button", { name: "Boundary button" });
  button.focus();
  await user.keyboard(" ");
  await user.keyboard("{Enter}");
  expect(vi.mocked(execute)).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByTestId("canvas"), { key: " ", code: "Space" });
  await waitFor(() =>
    expect(vi.mocked(execute)).toHaveBeenCalledWith(
      "transport.togglePlay",
      expect.anything(),
      expect.objectContaining({ skipWhen: true }),
    ),
  );
});

it("consumes a denied focused fade arrow without moving the playhead", async () => {
  useDawStore.getState().hydrate("share:readonly", minimalProject());
  useDawStore.getState().setPlayheadSec(1);
  const run = vi.fn(() => ({ status: "ok" as const }));
  disposeHandle = registerFocusedClipHandle({
    kind: "fade",
    run,
    cancel: vi.fn(),
  });
  render(<KeymapHost />);
  const canvas = screen.getByTestId("canvas");
  const event = new KeyboardEvent("keydown", {
    key: "ArrowRight",
    code: "ArrowRight",
    bubbles: true,
    cancelable: true,
  });

  await act(async () => {
    fireEvent(canvas, event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(event.defaultPrevented).toBe(true);
  expect(execute).toHaveBeenCalledWith(
    "edit.setClipFade",
    { phase: "nudge", direction: 1, shift: false, held: false },
    expect.objectContaining({ skipWhen: true }),
  );
  expect(run).not.toHaveBeenCalled();
  expect(useDawStore.getState().playheadSec).toBe(1);
});

/** The app shortcuts the verifier pressed behind an open confirm (#1031). */
const SHORTCUTS = [
  {
    label: "Mod+Z",
    init: { key: "z", code: "KeyZ", metaKey: true, ctrlKey: true },
    id: "history.undo",
  },
  {
    label: "Mod+Shift+Z",
    init: {
      key: "Z",
      code: "KeyZ",
      metaKey: true,
      ctrlKey: true,
      shiftKey: true,
    },
    id: "history.redo",
  },
  {
    label: "Space",
    init: { key: " ", code: "Space" },
    id: "transport.togglePlay",
  },
  {
    label: "Delete",
    init: { key: "Delete", code: "Delete" },
    id: "track.remove",
  },
] as const;

it("holds every app shortcut while an in-app confirm is open, and hands them back once it closes", async () => {
  vi.mocked(execute).mockImplementation(async () => ({ status: "ok" }));
  useDawStore.setState({ selection: { kind: "track", trackId: "guest" } });
  render(
    <>
      <KeymapHost />
      <AskDialog />
    </>,
  );
  const canvas = screen.getByTestId("canvas");
  let answer!: Promise<boolean>;
  act(() => {
    answer = askConfirm({
      title: "Remove the guest track?",
      message: "Its clips go too.",
      keepLabel: "Keep track",
      actionLabel: "Remove track",
      danger: true,
    });
  });
  await screen.findByRole("dialog", { name: "Remove the guest track?" });

  for (const { init } of SHORTCUTS) {
    await act(async () => {
      fireEvent.keyDown(canvas, init);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(vi.mocked(execute)).not.toHaveBeenCalled();
  expect(
    screen.getByRole("dialog", { name: "Remove the guest track?" }),
  ).toBeInTheDocument();

  await userEvent.setup().keyboard("{Escape}");
  await expect(answer).resolves.toBe(false);
  expect(screen.queryByRole("dialog")).toBeNull();

  for (const { init, id } of SHORTCUTS) {
    vi.mocked(execute).mockClear();
    fireEvent.keyDown(canvas, init);
    await waitFor(() =>
      expect(vi.mocked(execute)).toHaveBeenCalledWith(
        id,
        expect.anything(),
        expect.objectContaining({ skipWhen: true }),
      ),
    );
  }
});

it("keeps native typing in a dialog's text field while the app shortcuts are held", async () => {
  const user = userEvent.setup();
  render(
    <>
      <KeymapHost />
      <AskDialog />
    </>,
  );
  act(() => {
    void askText({
      title: "Link audio",
      label: "File path",
      submitLabel: "Link",
      requiredMessage: "Enter a path.",
    });
  });
  const field = await screen.findByRole("textbox", { name: "File path" });
  await waitFor(() => expect(field).toHaveFocus());
  await user.keyboard("a b{Backspace}{Delete}c");
  await user.keyboard("{Control>}z{/Control}");
  expect(field).toHaveValue("a c");
  expect(vi.mocked(execute)).not.toHaveBeenCalled();
});

it("lets through only the shortcuts the open modal hands on: M drops a marker in the Record room", async () => {
  vi.mocked(execute).mockImplementation(async () => ({ status: "ok" }));
  useDawStore.setState({ recordPanelOpen: true });
  const { rerender } = render(
    <>
      <KeymapHost />
      <Dialog
        open
        title="Record room"
        onClose={vi.fn()}
        shortcuts={["record.marker"]}
      >
        <p>Recording</p>
      </Dialog>
    </>,
  );
  const canvas = screen.getByTestId("canvas");
  fireEvent.keyDown(canvas, { key: "m", code: "KeyM" });
  await waitFor(() =>
    expect(vi.mocked(execute)).toHaveBeenCalledWith(
      "record.marker",
      expect.anything(),
      expect.anything(),
    ),
  );
  expect(vi.mocked(execute)).not.toHaveBeenCalledWith(
    "track.muteToggle",
    expect.anything(),
    expect.anything(),
  );

  // A confirm over the Record room holds M too.
  vi.mocked(execute).mockClear();
  rerender(
    <>
      <KeymapHost />
      <Dialog
        open
        title="Record room"
        onClose={vi.fn()}
        shortcuts={["record.marker"]}
      >
        <p>Recording</p>
      </Dialog>
      <Dialog open title="Leave the room?" onClose={vi.fn()}>
        <p>Leave?</p>
      </Dialog>
    </>,
  );
  await act(async () => {
    fireEvent.keyDown(canvas, { key: "m", code: "KeyM" });
    fireEvent.keyDown(canvas, {
      key: "z",
      code: "KeyZ",
      metaKey: true,
      ctrlKey: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(vi.mocked(execute)).not.toHaveBeenCalled();
});
