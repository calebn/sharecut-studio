import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { UNDO_TOAST_MS, UndoToast } from "./UndoToast";

describe("UndoToast", () => {
  it("renders the message in a status region and wires Undo/Dismiss", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={onUndo}
        onDismiss={onDismiss}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Resolved comment at 00:12");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("renders an empty status region with no buttons when toast is null", () => {
    render(<UndoToast toast={null} onUndo={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("auto-dismisses after the timeout", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("pauses the timer while focused and resumes after blur", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    const undoButton = screen.getByRole("button", { name: "Undo" });
    act(() => {
      undoButton.focus();
    });
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS + 1000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      undoButton.blur();
    });
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("pauses the timer while hovered and resumes after pointerleave", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    const region = screen.getByRole("status").querySelector(".undo-toast");
    expect(region).not.toBeNull();
    fireEvent.pointerEnter(region!, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS + 1000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerLeave(region!);
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("does not pause on touch pointerenter (no persistent hover)", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.pointerEnter(
      screen.getByRole("status").querySelector(".undo-toast")!,
      { pointerType: "touch" },
    );
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("restarts the timer when a new id replaces the toast", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS - 100);
    });
    rerender(
      <UndoToast
        toast={{ id: 2, message: "Resolved comment at 00:20" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS - 200);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("keeps the hover pause when a new id replaces the toast under the pointer", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    const card = screen.getByRole("status").querySelector(".undo-toast");
    expect(card).not.toBeNull();
    fireEvent.pointerEnter(card!, { pointerType: "mouse" });
    rerender(
      <UndoToast
        toast={{ id: 2, message: "Resolved comment at 00:20" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS + 1000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerLeave(
      screen.getByRole("status").querySelector(".undo-toast")!,
    );
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("resets the hover pause after the toast closes", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.pointerEnter(
      screen.getByRole("status").querySelector(".undo-toast")!,
      { pointerType: "mouse" },
    );
    rerender(<UndoToast toast={null} onUndo={vi.fn()} onDismiss={onDismiss} />);
    rerender(
      <UndoToast
        toast={{ id: 2, message: "Resolved comment at 00:20" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("disables Undo when undoDisabled is set", () => {
    render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        undoDisabled
      />,
    );
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("pauses the timer while Undo is disabled and restarts it after", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
        undoDisabled
      />,
    );
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS + 1000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    rerender(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("returns focus to returnFocusRef when it closes with focus inside", () => {
    const target = document.createElement("div");
    target.tabIndex = -1;
    document.body.appendChild(target);
    const returnFocusRef = { current: target };
    const { rerender } = render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    act(() => {
      screen.getByRole("button", { name: "Dismiss" }).focus();
    });
    rerender(
      <UndoToast
        toast={null}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    expect(document.activeElement).toBe(target);
    target.remove();
  });

  it("does not move focus when it closes with focus elsewhere", () => {
    const target = document.createElement("div");
    target.tabIndex = -1;
    const other = document.createElement("button");
    document.body.append(target, other);
    const returnFocusRef = { current: target };
    const { rerender } = render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    other.focus();
    rerender(
      <UndoToast
        toast={null}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    expect(document.activeElement).toBe(other);
    target.remove();
    other.remove();
  });

  it("returns focus when a disabled Undo was blurred to <body> before closing", () => {
    const target = document.createElement("div");
    target.tabIndex = -1;
    document.body.appendChild(target);
    const returnFocusRef = { current: target };
    const { rerender } = render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    const undo = screen.getByRole("button", { name: "Undo" });
    act(() => {
      undo.focus();
    });
    rerender(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        undoDisabled
        returnFocusRef={returnFocusRef}
      />,
    );
    // Chromium's focus fixup blurs a focused button once it is disabled
    // (relatedTarget null); jsdom's native .blur() no-ops on a disabled
    // element, so toggle the underlying DOM property off just long enough to
    // fire a real blur with relatedTarget null, then restore it to match the
    // disabled markup React rendered.
    expect(undo).toBeDisabled();
    act(() => {
      (undo as HTMLButtonElement).disabled = false;
      undo.blur();
      (undo as HTMLButtonElement).disabled = true;
    });
    rerender(
      <UndoToast
        toast={null}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    expect(document.activeElement).toBe(target);
    target.remove();
  });

  it("does not move focus when focus left the toast for another element", () => {
    const target = document.createElement("div");
    target.tabIndex = -1;
    const other = document.createElement("button");
    document.body.append(target, other);
    const returnFocusRef = { current: target };
    const { rerender } = render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    act(() => {
      screen.getByRole("button", { name: "Dismiss" }).focus();
    });
    act(() => {
      other.focus();
    });
    rerender(
      <UndoToast
        toast={null}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    expect(document.activeElement).toBe(other);
    target.remove();
    other.remove();
  });

  it("is axe-clean with a toast shown", async () => {
    const { container } = render(
      <UndoToast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
