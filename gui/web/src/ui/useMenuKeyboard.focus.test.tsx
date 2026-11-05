import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubRaf } from "../test/raf";
import { menuOpen } from "./modalGate";
import { usePressedControl } from "./pressedControl";
import { useMenuKeyboard } from "./useMenuKeyboard";

afterEach(cleanup);

const leaveOpen = () => undefined;

function Menu() {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  useMenuKeyboard({ open: true, panel, close: leaveOpen });
  return (
    <div ref={setPanel} role="menu">
      <button type="button" role="menuitem">
        Item
      </button>
    </div>
  );
}

function PressedControlCapture() {
  usePressedControl();
  return null;
}

async function openMenuFrom(opener: HTMLElement) {
  document.body.append(opener);
  const capture = render(<PressedControlCapture />);
  fireEvent.click(opener);
  const view = render(<Menu />);
  await waitFor(() => expect(screen.getByRole("menuitem")).toHaveFocus());
  return {
    unmount: () => {
      view.unmount();
      capture.unmount();
    },
  };
}

describe("useMenuKeyboard focus return", () => {
  it("keeps one focus session while reading a replacement panel", () => {
    const raf = stubRaf();
    const close = vi.fn();
    const opener = document.createElement("button");
    const elsewhere = document.createElement("button");
    document.body.append(opener, elsewhere);
    opener.focus();
    function Session({ revision }: { revision: number }) {
      const [panel, setPanel] = useState<HTMLDivElement | null>(null);
      useMenuKeyboard({ open: true, panel, close });
      return (
        <div key={revision} ref={setPanel} role="menu">
          <button type="button" role="menuitem">
            First {revision}
          </button>
          <button type="button" role="menuitem">
            Last {revision}
          </button>
        </div>
      );
    }
    const { rerender, unmount } = render(<Session revision={1} />);
    try {
      act(() => raf.fire(0));
      expect(screen.getByRole("menuitem", { name: "First 1" })).toHaveFocus();
      elsewhere.focus();
      rerender(<Session revision={2} />);
      expect(raf.pendingCount()).toBe(0);
      expect(elsewhere).toHaveFocus();
      act(() => screen.getByRole("menuitem", { name: "First 2" }).focus());
      fireEvent.keyDown(window, { key: "End" });
      expect(screen.getByRole("menuitem", { name: "Last 2" })).toHaveFocus();
      unmount();
      expect(opener).toHaveFocus();
      expect(close).not.toHaveBeenCalled();
    } finally {
      unmount();
      opener.remove();
      elsewhere.remove();
      vi.unstubAllGlobals();
    }
  });

  it("owns Escape and the shortcut gate without a keyboard panel", () => {
    const raf = stubRaf();
    const close = vi.fn();
    function Session() {
      useMenuKeyboard({ open: true, panel: null, close });
      return null;
    }
    const { unmount } = render(<Session />);
    try {
      expect(menuOpen()).toBe(true);
      act(() => raf.fire(0));
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        cancelable: true,
      });
      act(() => {
        window.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
      unmount();
      expect(menuOpen()).toBe(false);
    } finally {
      unmount();
      vi.unstubAllGlobals();
    }
  });

  it("gives focus back to the opener when the menu closes", async () => {
    const opener = document.createElement("button");
    const { unmount } = await openMenuFrom(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("leaves focus outside when focus moved there before the menu closes", async () => {
    const opener = document.createElement("button");
    const outside = document.createElement("button");
    document.body.append(opener, outside);
    const { unmount } = await openMenuFrom(opener);
    await waitFor(() => expect(screen.getByRole("menuitem")).toHaveFocus());
    outside.focus();
    unmount();
    expect(document.activeElement).toBe(outside);
    opener.remove();
    outside.remove();
  });

  it("does not give focus back to an opener inside an inert ancestor", async () => {
    const host = document.createElement("div");
    const opener = document.createElement("button");
    host.append(opener);
    document.body.append(host);
    opener.focus();
    const { unmount } = render(<Menu />);
    await waitFor(() => expect(screen.getByRole("menuitem")).toHaveFocus());
    host.setAttribute("inert", "");
    unmount();
    expect(document.activeElement).not.toBe(opener);
    host.remove();
  });

  it("does not restore focus to a removed opener", async () => {
    const opener = document.createElement("button");
    const { unmount } = await openMenuFrom(opener);
    opener.remove();
    unmount();
    expect(document.activeElement).toBe(document.body);
  });

  it("uses the focused control when the menu opens from the keyboard", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const capture = render(<PressedControlCapture />);
    const { unmount } = render(<Menu />);
    await waitFor(() => expect(screen.getByRole("menuitem")).toHaveFocus());
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
    capture.unmount();
  });
});
