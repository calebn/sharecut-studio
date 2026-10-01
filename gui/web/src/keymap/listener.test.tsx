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
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { useDawKeymapListener } from "./listener";

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
  disposeHandle?.();
  disposeHandle = null;
  clearRegisteredCommands();
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
    { phase: "nudge", direction: 1, shift: false },
    expect.objectContaining({ skipWhen: true }),
  );
  expect(run).not.toHaveBeenCalled();
  expect(useDawStore.getState().playheadSec).toBe(1);
});
