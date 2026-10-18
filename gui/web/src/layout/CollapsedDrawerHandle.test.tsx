import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import {
  CollapsedDrawerHandle,
  CollapsedDrawerHandleView,
  REOPEN_SWIPE_PX,
} from "./CollapsedDrawerHandle";

const NAME = { name: "Show editor panels" };

describe("CollapsedDrawerHandleView", () => {
  it("is a named button with no accessibility violations", async () => {
    const { container } = render(
      <CollapsedDrawerHandleView onReopen={vi.fn()} />,
    );
    expect(screen.getByRole("button", NAME)).toBeVisible();
    await expectNoA11yViolations(container);
  });

  it("reopens on tap, Enter and Space", async () => {
    const onReopen = vi.fn();
    render(<CollapsedDrawerHandleView onReopen={onReopen} />);
    await userEvent.click(screen.getByRole("button", NAME));
    screen.getByRole("button", NAME).focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onReopen.mock.calls).toEqual([[false], [true], [true]]);
  });

  it("reopens once on an upward swipe and ignores a short one or another finger", () => {
    const onReopen = vi.fn();
    render(<CollapsedDrawerHandleView onReopen={onReopen} />);
    const handle = screen.getByRole("button", NAME);
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientY: 500 - REOPEN_SWIPE_PX + 1,
    });
    fireEvent.pointerMove(handle, { pointerId: 2, clientY: 400 });
    expect(onReopen).not.toHaveBeenCalled();
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientY: 500 - REOPEN_SWIPE_PX,
    });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 400 });
    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  it("does not reopen on a downward drag or a canceled swipe", () => {
    const onReopen = vi.fn();
    render(<CollapsedDrawerHandleView onReopen={onReopen} />);
    const handle = screen.getByRole("button", NAME);
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 540 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 300 });
    fireEvent.pointerDown(handle, { pointerId: 2, clientY: 500 });
    fireEvent.pointerCancel(handle, { pointerId: 2 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientY: 300 });
    expect(onReopen).not.toHaveBeenCalled();
  });
});

describe("focus", () => {
  it("takes focus on mount when the collapsed splitter's focus was lost", () => {
    render(<CollapsedDrawerHandleView onReopen={vi.fn()} />);
    expect(screen.getByRole("button", NAME)).toHaveFocus();
  });

  it("leaves focus where it is when something else holds it", () => {
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    render(<CollapsedDrawerHandleView onReopen={vi.fn()} />);
    expect(other).toHaveFocus();
    other.remove();
  });
});

describe("CollapsedDrawerHandle", () => {
  it("runs Restore layout", async () => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.setState({ layoutMode: "timeline" });
    render(<CollapsedDrawerHandle />);
    await userEvent.click(screen.getByRole("button", NAME));
    await vi.waitFor(() =>
      expect(useDawStore.getState().layoutMode).toBe("default"),
    );
  });

  it("returns keyboard focus to the splitter, and leaves a tap alone", async () => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.setState({ layoutMode: "timeline" });
    const splitter = document.createElement("div");
    splitter.className = "bottom-tabs-splitter";
    splitter.tabIndex = 0;
    document.body.append(splitter);
    render(<CollapsedDrawerHandle />);
    screen.getByRole("button", NAME).focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(splitter).toHaveFocus());
    splitter.remove();
  });
});
