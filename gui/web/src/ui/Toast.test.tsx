import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { BUSY_REASON } from "./disabledReason";
import { TOAST_CLIPPED_MAX_MS, TOAST_MS, Toast } from "./Toast";

const region = () => document.querySelector(".ui-toast-region")!;

describe("Toast", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("uses the current return target when a surviving card closes", () => {
    const oldTarget = document.createElement("button");
    const currentTarget = document.createElement("button");
    document.body.append(oldTarget, currentTarget);
    const returnFocusRef = { current: oldTarget };
    const { rerender } = render(
      <Toast
        toast={{ id: 1, message: "Saved" }}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    act(() => screen.getByRole("button", { name: "Dismiss" }).focus());
    oldTarget.remove();
    returnFocusRef.current = currentTarget;
    rerender(
      <Toast
        toast={null}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    expect(currentTarget).toHaveFocus();
  });

  it.each(["disabled", "inert", "hidden", "disconnected"])(
    "does not focus a return target that is %s",
    (invalid) => {
      const target = document.createElement("button");
      document.body.append(target);
      const returnFocusRef = { current: target };
      const { rerender } = render(
        <Toast
          toast={{ id: 1, message: "Saved" }}
          onDismiss={vi.fn()}
          returnFocusRef={returnFocusRef}
        />,
      );
      act(() => screen.getByRole("button", { name: "Dismiss" }).focus());
      if (invalid === "disabled") target.disabled = true;
      if (invalid === "inert") target.setAttribute("inert", "");
      if (invalid === "hidden") target.style.display = "none";
      if (invalid === "disconnected") target.remove();
      const focus = vi.spyOn(target, "focus");
      rerender(
        <Toast
          toast={null}
          onDismiss={vi.fn()}
          returnFocusRef={returnFocusRef}
        />,
      );
      expect(focus).not.toHaveBeenCalled();
    },
  );

  it("renders the message and wires Undo/Dismiss", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    render(
      <Toast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={onUndo}
        onDismiss={onDismiss}
      />,
    );
    const status = region();
    expect(status).toHaveTextContent("Resolved comment at 00:12");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("renders an empty region with no buttons when toast is null", () => {
    render(<Toast toast={null} onUndo={vi.fn()} onDismiss={vi.fn()} />);
    expect(region()).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("auto-dismisses after the timeout", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <Toast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("pauses the timer while focused and resumes after blur", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <Toast
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
      vi.advanceTimersByTime(TOAST_MS + 1000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      undoButton.blur();
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_MS);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("pauses the timer while hovered and resumes after pointerleave", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <Toast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    const card = region().querySelector(".ui-toast");
    expect(card).not.toBeNull();
    fireEvent.pointerEnter(card!, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(TOAST_MS + 1000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerLeave(card!);
    act(() => {
      vi.advanceTimersByTime(TOAST_MS);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not pause on touch pointerenter (no persistent hover)", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <Toast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.pointerEnter(region().querySelector(".ui-toast")!, {
      pointerType: "touch",
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_MS);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("restarts the timer when a new id replaces the toast", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 100);
    });
    rerender(
      <Toast
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
      vi.advanceTimersByTime(TOAST_MS - 200);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps the hover pause when a new id replaces the toast under the pointer", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    const card = region().querySelector(".ui-toast");
    expect(card).not.toBeNull();
    fireEvent.pointerEnter(card!, { pointerType: "mouse" });
    rerender(
      <Toast
        toast={{ id: 2, message: "Resolved comment at 00:20" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(TOAST_MS + 1000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerLeave(region().querySelector(".ui-toast")!);
    act(() => {
      vi.advanceTimersByTime(TOAST_MS);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("resets the hover pause after the toast closes", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.pointerEnter(region().querySelector(".ui-toast")!, {
      pointerType: "mouse",
    });
    rerender(<Toast toast={null} onUndo={vi.fn()} onDismiss={onDismiss} />);
    rerender(
      <Toast
        toast={{ id: 2, message: "Resolved comment at 00:20" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(TOAST_MS);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("disables Undo when undoDisabledReason is set", () => {
    render(
      <Toast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        undoDisabledReason={BUSY_REASON}
      />,
    );
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toBeDisabled();
    expect(undo).toHaveAttribute("title", BUSY_REASON);
  });

  it("keeps Undo pressable and describes why it will not act at once with undoNote, paused while shown", async () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { container } = render(
      <Toast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
        undoNote="Undo ready after save"
      />,
    );
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toBeEnabled();
    expect(undo).toHaveAccessibleDescription(
      "Resolved comment at 00:12 Undo ready after save",
    );
    expect(screen.getByText("Undo ready after save")).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(TOAST_MS + 1000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    vi.useRealTimers();
    await expectNoA11yViolations(container);
  });

  it("pauses the timer while Undo is disabled and restarts it after", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
        undoDisabledReason={BUSY_REASON}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(TOAST_MS + 1000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    rerender(
      <Toast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("dismisses a card that stays clipped once its clipped pause is spent", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <Toast
        toast={{ id: 1, message: "Refresh failed" }}
        onDismiss={onDismiss}
        visibility="clipped"
      />,
    );
    act(() => {
      vi.advanceTimersByTime(TOAST_CLIPPED_MAX_MS);
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("preserves remaining time while clipped and through presentation changes", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const toast = { id: 1, message: "Time changed" };
    const { rerender } = render(<Toast toast={toast} onDismiss={onDismiss} />);
    const card = screen.getByText("Time changed").closest(".ui-toast");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    rerender(
      <Toast toast={toast} onDismiss={onDismiss} visibility="clipped" />,
    );
    act(() => {
      vi.advanceTimersByTime(TOAST_CLIPPED_MAX_MS - 1000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    rerender(
      <Toast
        toast={toast}
        onDismiss={onDismiss}
        visibility="visible"
        className="flow"
      />,
    );
    expect(screen.getByText("Time changed").closest(".ui-toast")).toBe(card);
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("returns focus to returnFocusRef when it closes with focus inside", () => {
    const target = document.createElement("div");
    target.tabIndex = -1;
    document.body.appendChild(target);
    const focus = vi.spyOn(target, "focus");
    const returnFocusRef = { current: target };
    const { rerender } = render(
      <Toast
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
      <Toast
        toast={null}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    expect(document.activeElement).toBe(target);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    target.remove();
  });

  it("does not move focus when it closes with focus elsewhere", () => {
    const target = document.createElement("div");
    target.tabIndex = -1;
    const other = document.createElement("button");
    document.body.append(target, other);
    const returnFocusRef = { current: target };
    const { rerender } = render(
      <Toast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    other.focus();
    rerender(
      <Toast
        toast={null}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    expect(document.activeElement).toBe(other);
  });

  it("returns focus when a disabled Undo was blurred to <body> before closing", () => {
    const target = document.createElement("div");
    target.tabIndex = -1;
    document.body.appendChild(target);
    const returnFocusRef = { current: target };
    const { rerender } = render(
      <Toast
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
      <Toast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        undoDisabledReason={BUSY_REASON}
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
      <Toast
        toast={null}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    expect(document.activeElement).toBe(target);
  });

  it("does not move focus when focus left the toast for another element", () => {
    const target = document.createElement("div");
    target.tabIndex = -1;
    const other = document.createElement("button");
    document.body.append(target, other);
    const returnFocusRef = { current: target };
    const { rerender } = render(
      <Toast
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
      <Toast
        toast={null}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );
    expect(document.activeElement).toBe(other);
  });

  it("is axe-clean with a toast shown", async () => {
    const { container } = render(
      <Toast
        toast={{ id: 1, message: "Resolved comment at 00:12" }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("shows no Undo without onUndo, and auto-dismisses", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <Toast
        toast={{ id: 1, message: "Guest link copied" }}
        onDismiss={onDismiss}
      />,
    );
    expect(region()).toHaveTextContent("Guest link copied");
    expect(
      screen.queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(TOAST_MS);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("describes Undo by the message it reverses", () => {
    render(
      <Toast
        toast={{ id: 1, message: "Removed guest" }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Undo" }),
    ).toHaveAccessibleDescription("Removed guest");
  });

  it("is never a live region: the shell's one region speaks the message", async () => {
    const { container } = render(
      <Toast
        className="ui-toast-region--app"
        toast={{ id: 1, message: "Reordered track" }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(region()).not.toHaveAttribute("aria-live");
    expect(container.firstElementChild).toHaveClass(
      "ui-toast-region",
      "ui-toast-region--app",
    );
    expect(screen.getByText("Reordered track")).toBeVisible();
    await expectNoA11yViolations(container);
  });

  it("styles an error apart from a status", () => {
    const { rerender } = render(
      <Toast toast={{ id: 1, message: "Saved" }} onDismiss={vi.fn()} />,
    );
    expect(document.querySelector(".ui-toast")).not.toHaveClass(
      "ui-toast--error",
    );
    rerender(
      <Toast
        toast={{ id: 2, message: "Refresh failed", tone: "error" }}
        onDismiss={vi.fn()}
      />,
    );
    expect(document.querySelector(".ui-toast")).toHaveClass("ui-toast--error");
  });
});
