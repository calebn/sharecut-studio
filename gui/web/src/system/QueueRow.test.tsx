import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QueueRow } from "./QueueRow";

const swipe = (el: Element, dx: number) => {
  fireEvent.pointerDown(el, {
    clientX: 100,
    clientY: 0,
    isPrimary: true,
    pointerId: 1,
  });
  fireEvent.pointerMove(el, { clientX: 100 + dx, clientY: 0, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: 100 + dx, clientY: 0, pointerId: 1 });
};

describe("QueueRow", () => {
  it("selects on click and marks the current row", async () => {
    const onSelect = vi.fn();
    render(
      <QueueRow
        kind="filler"
        snippet="um"
        time="18:36"
        selected
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.getByRole("button")).toHaveAttribute("aria-current", "true");
  });

  it("swipes right for the verb and left for Keep, and a swipe does not select", () => {
    const onVerb = vi.fn();
    const onKeep = vi.fn();
    const onSelect = vi.fn();
    render(
      <QueueRow
        kind="filler"
        snippet="um"
        time="18:36"
        onSelect={onSelect}
        onVerb={onVerb}
        onKeep={onKeep}
      />,
    );
    const button = screen.getByRole("button");
    swipe(button, 90);
    fireEvent.click(button);
    swipe(button, -90);
    expect(onVerb).toHaveBeenCalledOnce();
    expect(onKeep).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("ignores a swipe under 80 px", () => {
    const onVerb = vi.fn();
    const onKeep = vi.fn();
    render(
      <QueueRow
        kind="filler"
        snippet="um"
        time="18:36"
        onVerb={onVerb}
        onKeep={onKeep}
      />,
    );
    swipe(screen.getByRole("button"), 79);
    swipe(screen.getByRole("button"), -79);
    expect(onVerb).not.toHaveBeenCalled();
    expect(onKeep).not.toHaveBeenCalled();
  });

  it("does not swipe once decided", () => {
    const onVerb = vi.fn();
    const { container } = render(
      <QueueRow
        kind="filler"
        snippet="um"
        time="18:36"
        decided={{ result: "applied", text: "Cut 0.8 s" }}
        onVerb={onVerb}
      />,
    );
    swipe(container.firstElementChild as Element, 120);
    expect(onVerb).not.toHaveBeenCalled();
  });

  it("collapses a decided row to one line with no button", () => {
    render(
      <QueueRow
        kind="filler"
        snippet="um"
        time="18:36"
        decided={{ result: "applied", text: "Cut 0.8 s" }}
      />,
    );
    expect(screen.getByText("Cut 0.8 s")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows unread and waiting-to-send", () => {
    render(
      <QueueRow
        kind="comment"
        author={{ name: "Rosa" }}
        snippet="Hi"
        time="1:00"
        unread
        offline
      />,
    );
    expect(screen.getByRole("img", { name: "Unread" })).toBeInTheDocument();
    expect(screen.getByText("Waiting to send")).toBeInTheDocument();
  });
});
