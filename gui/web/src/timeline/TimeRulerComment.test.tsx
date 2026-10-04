import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawKeymapListener } from "../keymap/listener";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { TimeRuler } from "./TimeRuler";

class RulerPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.isPrimary = init.isPrimary ?? true;
  }
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", RulerPointerEvent);
  useDawStore.getState().hydrate("/tmp/ruler-comments", minimalProject());
  useDawStore.getState().setCommentMode(true);
  useDawStore.getState().setCommentDraft({ startSec: 2, endSec: null });
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const onSeek = vi.fn();
  const view = render(
    <TimeRuler
      durationSec={60}
      sessionDurationSec={60}
      zoomPxPerSec={10}
      onSeek={onSeek}
    />,
  );
  const ruler = screen.getByRole("slider");
  const captured = new Set<number>();
  const capture = vi.fn((id: number) => captured.add(id));
  Object.assign(ruler, {
    setPointerCapture: capture,
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: vi.fn((id: number) => {
      captured.delete(id);
      fireEvent.lostPointerCapture(ruler, { pointerId: id });
    }),
  });
  return { ...view, ruler, captured, onSeek, capture };
}

it.each(["cancel", "loss"] as const)(
  "restores on owner %s and makes held movement/release inert",
  (terminal) => {
    const { ruler, captured, onSeek } = setup();
    fireEvent.pointerDown(ruler, { pointerId: 1, clientX: 40, button: 0 });
    fireEvent.pointerMove(ruler, { pointerId: 1, clientX: 100 });
    expect(useDawStore.getState().commentDraft).toEqual({
      startSec: 4,
      endSec: 10,
    });
    expect(captured.has(1)).toBe(true);
    if (terminal === "cancel") fireEvent.pointerCancel(ruler, { pointerId: 1 });
    else fireEvent.lostPointerCapture(ruler, { pointerId: 1 });
    expect(useDawStore.getState().commentDraft).toEqual({
      startSec: 2,
      endSec: null,
    });
    expect(captured.size).toBe(0);
    fireEvent.pointerMove(ruler, { pointerId: 1, clientX: 120 });
    fireEvent.pointerUp(ruler, { pointerId: 1, clientX: 120 });
    expect(useDawStore.getState().commentDraft).toEqual({
      startSec: 2,
      endSec: null,
    });
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(4);
    fireEvent.pointerDown(ruler, { pointerId: 2, clientX: 60, button: 0 });
    fireEvent.pointerMove(ruler, { pointerId: 2, clientX: 30 });
    fireEvent.pointerUp(ruler, { pointerId: 2, clientX: 30 });
    expect(useDawStore.getState().commentDraft).toEqual({
      startSec: 3,
      endSec: 6,
    });
    expect(captured.size).toBe(0);
  },
);

it("ignores foreign down/move/terminal events and non-primary admission", () => {
  const { ruler, captured, onSeek } = setup();
  fireEvent.pointerDown(ruler, { pointerId: 3, clientX: 40, button: 2 });
  fireEvent.pointerDown(ruler, {
    pointerId: 3,
    clientX: 40,
    button: 0,
    isPrimary: false,
  });
  expect(captured.size).toBe(0);
  expect(onSeek).not.toHaveBeenCalled();
  fireEvent.pointerDown(ruler, { pointerId: 1, clientX: 40, button: 0 });
  fireEvent.pointerDown(ruler, { pointerId: 2, clientX: 200, button: 0 });
  fireEvent.pointerMove(ruler, { pointerId: 2, clientX: 200 });
  fireEvent.pointerCancel(ruler, { pointerId: 2 });
  fireEvent.lostPointerCapture(ruler, { pointerId: 2 });
  fireEvent.pointerUp(ruler, { pointerId: 2, clientX: 200 });
  expect(useDawStore.getState().commentDraft).toEqual({
    startSec: 4,
    endSec: null,
  });
  expect(captured.has(1)).toBe(true);
  fireEvent.pointerUp(ruler, { pointerId: 1, clientX: 43 });
  expect(useDawStore.getState().commentDraft).toEqual({
    startSec: 4,
    endSec: null,
  });
  expect(onSeek).toHaveBeenCalledExactlyOnceWith(4);
});

it("leaves no draft write or seek when capture fails", () => {
  const { ruler, onSeek, capture } = setup();
  capture.mockImplementationOnce(() => {
    throw new Error("capture failed");
  });
  fireEvent.pointerDown(ruler, { pointerId: 1, clientX: 40, button: 0 });
  fireEvent.pointerMove(ruler, { pointerId: 1, clientX: 100 });
  expect(useDawStore.getState().commentDraft).toEqual({
    startSec: 2,
    endSec: null,
  });
  expect(onSeek).not.toHaveBeenCalled();
});

it.each(["draft", "mode", "epoch"] as const)(
  "releases capture immediately on %s departure without stale restoration",
  (departure) => {
    const { ruler, captured } = setup();
    fireEvent.pointerDown(ruler, { pointerId: 1, clientX: 40, button: 0 });
    fireEvent.pointerMove(ruler, { pointerId: 1, clientX: 100 });
    act(() => {
      if (departure === "draft")
        useDawStore.getState().setCommentDraft({ startSec: 20, endSec: null });
      if (departure === "mode") useDawStore.getState().setCommentMode(false);
      if (departure === "epoch")
        useDawStore.setState({
          projectEpoch: useDawStore.getState().projectEpoch + 1,
        });
    });
    const draft = useDawStore.getState().commentDraft;
    expect(captured.size).toBe(0);
    fireEvent.pointerUp(ruler, { pointerId: 1, clientX: 120 });
    expect(useDawStore.getState().commentDraft).toBe(draft);
  },
);

it("restores on unmount without undoing its initial seek or reopening Comments", () => {
  const { ruler, unmount, captured, onSeek } = setup();
  fireEvent.pointerDown(ruler, { pointerId: 1, clientX: 40, button: 0 });
  act(() => useDawStore.getState().setActiveTab("transcript"));
  unmount();
  expect(captured.size).toBe(0);
  expect(useDawStore.getState().commentDraft).toEqual({
    startSec: 2,
    endSec: null,
  });
  expect(useDawStore.getState().activeTab).toBe("transcript");
  expect(onSeek).toHaveBeenCalledExactlyOnceWith(4);
});

function CommentKeymapHost() {
  useDawKeymapListener();
  return null;
}

it("preserves global Escape tool exit without resurrecting the prior draft", () => {
  clearRegisteredCommands();
  registerDawCommands();
  const keymap = render(<CommentKeymapHost />);
  const { ruler, captured, unmount } = setup();
  try {
    fireEvent.pointerDown(ruler, { pointerId: 1, clientX: 40, button: 0 });
    fireEvent.pointerMove(ruler, { pointerId: 1, clientX: 100 });
    fireEvent.keyDown(ruler, { key: "Escape", code: "Escape" });
    expect(useDawStore.getState().commentMode).toBe(false);
    expect(useDawStore.getState().commentDraft).toBeNull();
    expect(captured.size).toBe(0);
    fireEvent.pointerMove(ruler, { pointerId: 1, clientX: 120 });
    fireEvent.pointerUp(ruler, { pointerId: 1, clientX: 120 });
    expect(useDawStore.getState().commentDraft).toBeNull();
  } finally {
    unmount();
    keymap.unmount();
    clearRegisteredCommands();
  }
});
