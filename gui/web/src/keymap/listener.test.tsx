import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { redoHistory, undoHistory } from "../api";
import { clearRegisteredCommands, execute } from "../commands/execute";
import { registerFocusedClipHandle } from "../commands/focusedClipHandle";
import { registerDawCommands } from "../commands/register";
import { AskDialog } from "../feedback/AskDialog";
import { askConfirm } from "../feedback/ask";
import { useDawStore } from "../state/dawStore";
import { trackEditSave } from "../state/documentSendOrder";
import { setChrome } from "../test/chrome";
import { minimalProject } from "../test/fixtures";
import { BottomSheet } from "../ui/BottomSheet";
import { Dialog } from "../ui/Dialog";
import { Menu, MenuItem } from "../ui/Menu";
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

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  undoHistory: vi.fn(async () => null),
  redoHistory: vi.fn(async () => null),
}));

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
  useDawStore.setState({ selection: null, stage: "edit" });
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

it("leaves Escape to an open sheet instead of also clearing the selection", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  useDawStore.setState({ selection: { kind: "chapter", id: "c1", time: 1 } });
  render(
    <>
      <KeymapHost />
      <BottomSheet
        open
        onClose={onClose}
        backgroundPolicy="interactive"
        title="Inspector"
      >
        <button type="button">Inspector field</button>
      </BottomSheet>
    </>,
  );
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(vi.mocked(execute)).not.toHaveBeenCalled();
  expect(useDawStore.getState().selection).not.toBeNull();
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
  showHistory({ can_undo: true, can_redo: true });
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
  const field = createRef<HTMLInputElement>();
  render(
    <>
      <KeymapHost />
      <Dialog open title="Link audio" onClose={vi.fn()} initialFocusRef={field}>
        <input ref={field} aria-label="File path" />
      </Dialog>
    </>,
  );
  const input = await screen.findByRole("textbox", { name: "File path" });
  await waitFor(() => expect(input).toHaveFocus());
  await user.keyboard("a b{Backspace}{Delete}c");
  await user.keyboard("{Control>}z{/Control}");
  expect(input).toHaveValue("a c");
  expect(vi.mocked(execute)).not.toHaveBeenCalled();
});

it("lets through only the shortcuts the open modal hands on: M drops a marker", async () => {
  vi.mocked(execute).mockImplementation(async () => ({ status: "ok" }));
  useDawStore.setState({ stage: "record" });
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
    "edit.mute",
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

const GATED_DIALOGS = [
  { title: "Commands and shortcuts", flag: "commandPaletteOpen" },
] as const;

it.each(GATED_DIALOGS)(
  "holds the keymap behind the $title dialog through the one gate, with no store flag",
  async ({ title }) => {
    vi.mocked(execute).mockImplementation(async () => ({ status: "ok" }));
    const { rerender } = render(
      <>
        <KeymapHost />
        <Dialog open title={title} onClose={vi.fn()}>
          <p>Body</p>
        </Dialog>
      </>,
    );
    const canvas = screen.getByTestId("canvas");
    await act(async () => {
      fireEvent.keyDown(canvas, { key: " ", code: "Space" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(execute)).not.toHaveBeenCalled();

    rerender(
      <>
        <KeymapHost />
        <Dialog open={false} title={title} onClose={vi.fn()}>
          <p>Body</p>
        </Dialog>
      </>,
    );
    fireEvent.keyDown(canvas, { key: " ", code: "Space" });
    await waitFor(() =>
      expect(vi.mocked(execute)).toHaveBeenCalledWith(
        "transport.togglePlay",
        expect.anything(),
        expect.anything(),
      ),
    );
  },
);

it("ignores the dialog open flags in the store: only a mounted overlay holds the keymap", async () => {
  vi.mocked(execute).mockImplementation(async () => ({ status: "ok" }));
  setChrome({
    commandPaletteOpen: true,
    helpDialogOpen: true,
  });
  render(<KeymapHost />);
  fireEvent.keyDown(screen.getByTestId("canvas"), { key: " ", code: "Space" });
  await waitFor(() => expect(vi.mocked(execute)).toHaveBeenCalled());
  setChrome({
    commandPaletteOpen: false,
    helpDialogOpen: false,
  });
});

it("holds the keymap while a menu is open", async () => {
  vi.mocked(execute).mockImplementation(async () => ({ status: "ok" }));
  const user = userEvent.setup();
  render(
    <>
      <KeymapHost />
      <Menu
        open
        onOpenChange={vi.fn()}
        label="Test menu"
        trigger={(t) => (
          <button type="button" ref={t.ref} onClick={t.onClick}>
            Open
          </button>
        )}
      >
        <MenuItem>One</MenuItem>
      </Menu>
    </>,
  );
  await screen.findByRole("menu", { name: "Test menu" });
  await act(async () => {
    fireEvent.keyDown(screen.getByTestId("canvas"), {
      key: " ",
      code: "Space",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(vi.mocked(execute)).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
});

async function pressOnCanvas(key: string, code: string): Promise<string[]> {
  vi.mocked(execute).mockClear();
  vi.mocked(execute).mockImplementation(async () => ({ status: "ok" }));
  await act(async () => {
    fireEvent.keyDown(screen.getByTestId("canvas"), { key, code });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return vi.mocked(execute).mock.calls.map(([id]) => id);
}

it("deletes the clip on Backspace on Edit and runs nothing on Review", async () => {
  render(<KeymapHost />);
  useDawStore.setState({ stage: "review", reviewSection: "queue" });
  expect(await pressOnCanvas("Backspace", "Backspace")).toEqual([]);
  useDawStore.setState({ stage: "edit" });
  expect(await pressOnCanvas("Backspace", "Backspace")).toEqual([
    "edit.delete",
  ]);
});

it("drops a marker on M on the Record stage and mutes the track on any other stage", async () => {
  render(<KeymapHost />);
  useDawStore.setState({ stage: "record" });
  expect(await pressOnCanvas("m", "KeyM")).toEqual(["record.marker"]);
  useDawStore.setState({ stage: "edit" });
  expect(await pressOnCanvas("m", "KeyM")).toEqual(["edit.mute"]);
});

async function pressModZ(shiftKey: boolean) {
  await act(async () => {
    fireEvent.keyDown(screen.getByTestId("canvas"), {
      key: shiftKey ? "Z" : "z",
      code: "KeyZ",
      metaKey: true,
      ctrlKey: true,
      shiftKey,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function showHistory(history: { can_undo: boolean; can_redo: boolean }) {
  const project = minimalProject();
  useDawStore.getState().hydrate("/tmp/keymap-project", {
    ...project,
    history: {
      ...project.history,
      head_id: "head-1" as typeof project.history.head_id,
      ...history,
    },
  });
}

it("Mod+Z with nothing to undo does not send the command (#2168)", async () => {
  render(<KeymapHost />);
  vi.mocked(undoHistory).mockClear();
  showHistory({ can_undo: false, can_redo: false });
  await pressModZ(false);
  expect(undoHistory).not.toHaveBeenCalled();
  showHistory({ can_undo: true, can_redo: false });
  await pressModZ(false);
  expect(undoHistory).toHaveBeenCalledTimes(1);
});

it("Mod+Shift+Z with nothing to redo does not send the command (#2168)", async () => {
  render(<KeymapHost />);
  vi.mocked(redoHistory).mockClear();
  showHistory({ can_undo: true, can_redo: false });
  await pressModZ(true);
  expect(redoHistory).not.toHaveBeenCalled();
  showHistory({ can_undo: true, can_redo: true });
  await pressModZ(true);
  expect(redoHistory).toHaveBeenCalledTimes(1);
});

it("Mod+Z still sends while an edit's save is in flight (#2168)", async () => {
  render(<KeymapHost />);
  vi.mocked(undoHistory).mockClear();
  showHistory({ can_undo: false, can_redo: false });
  let landed!: () => void;
  const save = trackEditSave(
    "/tmp/keymap-project",
    new Promise<void>((resolve) => {
      landed = resolve;
    }),
  );
  await pressModZ(false);
  expect(undoHistory).not.toHaveBeenCalled();
  landed();
  await save;
  await waitFor(() => expect(undoHistory).toHaveBeenCalledTimes(1));
});

async function press(
  target: Element,
  init: KeyboardEventInit & { key: string },
): Promise<string[]> {
  vi.mocked(execute).mockClear();
  vi.mocked(execute).mockImplementation(async () => ({ status: "ok" }));
  await act(async () => {
    fireEvent.keyDown(target, init);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return vi.mocked(execute).mock.calls.map(([id]) => id);
}

it("binds the Action bar's keys: S, X, I, ., A, B, C, Shift+C and Shift+S", async () => {
  render(<KeymapHost />);
  const canvas = screen.getByTestId("canvas");
  const keys: [KeyboardEventInit & { key: string }, string][] = [
    [{ key: "s", code: "KeyS" }, "edit.split"],
    [{ key: "S", code: "KeyS", shiftKey: true }, "track.soloToggle"],
    [{ key: "x", code: "KeyX" }, "edit.keep"],
    [{ key: "i", code: "KeyI" }, "edit.inspect"],
    [{ key: ".", code: "Period" }, "edit.more"],
    [{ key: "a", code: "KeyA" }, "edit.hearBefore"],
    [{ key: "b", code: "KeyB" }, "edit.hearAfter"],
    [{ key: "c", code: "KeyC" }, "comment.draftAt"],
    [{ key: "C", code: "KeyC", shiftKey: true }, "edit.addChapter"],
  ];
  for (const [init, id] of keys)
    expect(await press(canvas, init), `${init.key}`).toEqual([id]);
});

it("Shift+Space hears on a focused button instead of clicking it", async () => {
  render(<KeymapHost />);
  const button = screen.getByRole("button", { name: "Boundary button" });
  const click = vi.fn();
  button.addEventListener("click", click);
  button.focus();
  expect(
    await press(button, { key: " ", code: "Space", shiftKey: true }),
  ).toEqual(["edit.hear"]);
  // The browser would click on the keyup: the listener takes it.
  const up = new KeyboardEvent("keyup", {
    key: " ",
    code: "Space",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  button.dispatchEvent(up);
  expect(up.defaultPrevented).toBe(true);
  expect(click).not.toHaveBeenCalled();
});

it("leaves a plain Space keyup alone and never takes a Space it did not handle", () => {
  render(<KeymapHost />);
  const up = new KeyboardEvent("keyup", {
    key: " ",
    bubbles: true,
    cancelable: true,
  });
  screen.getByRole("button", { name: "Boundary button" }).dispatchEvent(up);
  expect(up.defaultPrevented).toBe(false);
});

it("ignores a key while an IME composition is open", async () => {
  render(<KeymapHost />);
  expect(
    await press(screen.getByTestId("canvas"), {
      key: "s",
      code: "KeyS",
      isComposing: true,
    }),
  ).toEqual([]);
  expect(
    await press(screen.getByTestId("canvas"), {
      key: "Process",
      keyCode: 229,
    }),
  ).toEqual([]);
});

it("does not repeat Split while S is held", async () => {
  render(<KeymapHost />);
  expect(
    await press(screen.getByTestId("canvas"), {
      key: "s",
      code: "KeyS",
      repeat: true,
    }),
  ).toEqual([]);
});

it("says why a refused edit did nothing, in the live region", async () => {
  render(<KeymapHost />);
  useDawStore.setState({ statusAnnouncement: "" });
  vi.mocked(execute).mockImplementation(async () => ({
    status: "disabled",
    reason: "Move the playhead onto the clip to split it",
  }));
  await act(async () => {
    fireEvent.keyDown(screen.getByTestId("canvas"), {
      key: "s",
      code: "KeyS",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(useDawStore.getState().statusAnnouncement).toBe(
    "Move the playhead onto the clip to split it",
  );
});
