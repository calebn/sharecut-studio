import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_TO_STOP_MS, RecordButton } from "./RecordButton";

describe("RecordButton", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts a take on a press when idle, and resumes when paused", () => {
    const onStart = vi.fn();
    const { rerender } = render(
      <RecordButton face="idle" onStart={onStart} onStop={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    rerender(<RecordButton face="paused" onStart={onStart} onStop={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume recording" }));
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it("stops only after the full hold", () => {
    const onStop = vi.fn();
    render(<RecordButton face="live" onStart={vi.fn()} onStop={onStop} />);
    const button = screen.getByRole("button", { name: "Stop take" });
    fireEvent.pointerDown(button, { button: 0 });
    act(() => {
      vi.advanceTimersByTime(HOLD_TO_STOP_MS - 1);
    });
    expect(onStop).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("does not stop when the button becomes busy mid-hold", () => {
    const onStop = vi.fn();
    const { rerender } = render(
      <RecordButton face="live" onStart={vi.fn()} onStop={onStop} />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Stop take" }), {
      button: 0,
    });
    rerender(
      <RecordButton face="live" busy onStart={vi.fn()} onStop={onStop} />,
    );
    act(() => {
      vi.advanceTimersByTime(HOLD_TO_STOP_MS);
    });
    expect(onStop).not.toHaveBeenCalled();
  });

  it("a second pointer does not restart the hold", () => {
    const onStop = vi.fn();
    render(<RecordButton face="live" onStart={vi.fn()} onStop={onStop} />);
    const button = screen.getByRole("button", { name: "Stop take" });
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(HOLD_TO_STOP_MS - 100);
    });
    fireEvent.pointerDown(button, { button: 0, pointerId: 2 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("a second pointer does not leave a hold running after release", () => {
    const onStop = vi.fn();
    render(<RecordButton face="live" onStart={vi.fn()} onStop={onStop} />);
    const button = screen.getByRole("button", { name: "Stop take" });
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.pointerDown(button, { button: 0, pointerId: 2 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.pointerUp(button, { pointerId: 2 });
    act(() => {
      vi.advanceTimersByTime(HOLD_TO_STOP_MS * 2);
    });
    expect(onStop).not.toHaveBeenCalled();
  });

  it("an early release cancels and says to hold, then the hint goes", () => {
    const onStop = vi.fn();
    render(<RecordButton face="live" onStart={vi.fn()} onStop={onStop} />);
    const button = screen.getByRole("button", { name: "Stop take" });
    fireEvent.pointerDown(button, { button: 0 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerUp(button);
    act(() => {
      vi.advanceTimersByTime(HOLD_TO_STOP_MS);
    });
    expect(onStop).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Hold to stop");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("status")).not.toHaveTextContent("Hold to stop");
  });

  it("asks first on Enter, focusing Keep recording", async () => {
    vi.useRealTimers();
    const onStop = vi.fn();
    render(<RecordButton face="live" onStart={vi.fn()} onStop={onStop} />);
    screen.getByRole("button", { name: "Stop take" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onStop).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Keep recording" }),
    ).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onStop).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop take" })).toHaveFocus();
  });

  it("stops from the keyboard question", async () => {
    vi.useRealTimers();
    const onStop = vi.fn();
    render(<RecordButton face="live" onStart={vi.fn()} onStop={onStop} />);
    screen.getByRole("button", { name: "Stop take" }).focus();
    await userEvent.keyboard("{Enter}");
    const confirm = screen.getByRole("group", { name: /stop this take/i });
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Stop take" }),
    );
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("does nothing when disabled, and says why", () => {
    const onStart = vi.fn();
    render(
      <RecordButton
        face="idle"
        disabledReason="Waiting for Jon to join"
        onStart={onStart}
        onStop={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: "Record" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Waiting for Jon to join");
    fireEvent.click(button);
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("hold-to-stop motion token", () => {
  it("fills the ring over exactly the hold", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const tokens = readFileSync(
      join(here, "../styles/theme/tokens.css"),
      "utf8",
    );
    expect(tokens).toContain(`--motion-hold-to-stop: ${HOLD_TO_STOP_MS}ms;`);
  });
});
