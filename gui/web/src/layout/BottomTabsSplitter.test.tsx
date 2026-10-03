import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TABS_HEIGHT_STORAGE_KEY } from "../hooks/useTabsHeight";
import { expectNoA11yViolations } from "../test/a11y";
import { BottomTabsSplitter } from "./BottomTabsSplitter";

describe("BottomTabsSplitter", () => {
  beforeEach(() => {
    window.localStorage.removeItem(TABS_HEIGHT_STORAGE_KEY);
    document.documentElement.style.removeProperty("--tabs-height");
  });

  it("exposes a horizontal separator with resize affordance", async () => {
    const { container } = render(
      <div className="bottom-tabs" style={{ height: 200 }}>
        <BottomTabsSplitter />
      </div>,
    );
    const sep = screen.getByRole("separator", {
      name: "Resize editor panels",
    });
    expect(sep.getAttribute("aria-orientation")).toBe("horizontal");
    expect(sep.getAttribute("aria-valuemin")).toBe("8");
    await expectNoA11yViolations(container);
  });

  it("resets preference on double-click", async () => {
    window.localStorage.setItem(TABS_HEIGHT_STORAGE_KEY, "18");
    render(
      <div className="bottom-tabs" style={{ height: 200 }}>
        <BottomTabsSplitter />
      </div>,
    );
    const sep = screen.getByRole("separator", {
      name: "Resize editor panels",
    });
    await userEvent.dblClick(sep);
    expect(window.localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBeNull();
    expect(
      document.documentElement.style.getPropertyValue("--tabs-height"),
    ).toBe("");
  });

  it("grows via ArrowUp", async () => {
    render(
      <div className="bottom-tabs" style={{ height: 200 }}>
        <BottomTabsSplitter />
      </div>,
    );
    const sep = screen.getByRole("separator", {
      name: "Resize editor panels",
    });
    sep.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(window.localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).not.toBeNull();
    const stored = Number.parseFloat(
      window.localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)!,
    );
    expect(stored).toBeGreaterThan(12.5);
  });

  it("does not bubble Home to a parent keydown handler", async () => {
    const parentKeys: string[] = [];
    render(
      <div
        role="presentation"
        onKeyDown={(e) => {
          parentKeys.push(e.key);
        }}
      >
        <div className="bottom-tabs" style={{ height: 200 }}>
          <BottomTabsSplitter />
        </div>
      </div>,
    );
    const sep = screen.getByRole("separator", {
      name: "Resize editor panels",
    });
    sep.focus();
    await userEvent.keyboard("{Home}");
    expect(parentKeys).not.toContain("Home");
  });

  it("seeds ArrowUp from the measured panel when no preference is stored", async () => {
    render(
      <div className="bottom-tabs" style={{ height: 200 }}>
        <BottomTabsSplitter />
      </div>,
    );
    const sep = screen.getByRole("separator", {
      name: "Resize editor panels",
    });
    const panel = sep.parentElement!;
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 320,
      top: 0,
      left: 0,
      bottom: 320,
      right: 400,
      toJSON() {
        return {};
      },
    });
    sep.focus();
    await userEvent.keyboard("{ArrowUp}");
    const stored = Number.parseFloat(
      window.localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)!,
    );
    expect(stored).toBeGreaterThan(19);
  });
  it.each([null, "18"])(
    "Escape restores the exact prior preference %s and stops held movement",
    (stored) => {
      if (stored !== null)
        localStorage.setItem(TABS_HEIGHT_STORAGE_KEY, stored);
      render(
        <div>
          <BottomTabsSplitter />
        </div>,
      );
      const sep = screen.getByRole("separator", {
        name: "Resize editor panels",
      });
      fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
      fireEvent.pointerMove(sep, { pointerId: 1, clientY: 260 });
      expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe(
        stored === null ? "15" : "20.5",
      );
      fireEvent.keyDown(sep, { key: "Escape" });
      expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe(stored);
      expect(
        document.documentElement.style.getPropertyValue("--tabs-height"),
      ).toBe(stored === null ? "" : "18rem");
      fireEvent.pointerMove(sep, { pointerId: 1, clientY: 240 });
      fireEvent.pointerUp(sep, { pointerId: 1 });
      expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe(stored);
    },
  );

  it("restores a default on owner capture loss and leaves a no-op preference unset", () => {
    render(
      <div>
        <BottomTabsSplitter />
      </div>,
    );
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 280 });
    fireEvent.lostPointerCapture(sep, { pointerId: 1 });
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBeNull();
    fireEvent.pointerDown(sep, { pointerId: 2, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 2, clientY: 300 });
    fireEvent.pointerUp(sep, { pointerId: 2 });
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBeNull();
  });
  it("ignores foreign events and restores on owner cancellation before another gesture", () => {
    render(
      <div>
        <BottomTabsSplitter />
      </div>,
    );
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 99, clientY: 200 });
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBeNull();
    fireEvent.pointerDown(sep, { pointerId: 99, button: 0, clientY: 500 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 280 });
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe("13.75");
    fireEvent.pointerCancel(sep, { pointerId: 99 });
    fireEvent.lostPointerCapture(sep, { pointerId: 99 });
    fireEvent.pointerUp(sep, { pointerId: 99 });
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe("13.75");
    fireEvent.pointerCancel(sep, { pointerId: 1 });
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBeNull();
    fireEvent.pointerDown(sep, { pointerId: 2, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 2, clientY: 268 });
    fireEvent.pointerUp(sep, { pointerId: 2 });
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe("14.5");
  });

  it("restores on blur and unmount", () => {
    const { unmount } = render(
      <div>
        <BottomTabsSplitter />
      </div>,
    );
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 280 });
    fireEvent.blur(sep);
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBeNull();
    fireEvent.pointerDown(sep, { pointerId: 2, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 2, clientY: 280 });
    unmount();
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBeNull();
    expect(
      document.documentElement.style.getPropertyValue("--tabs-height"),
    ).toBe("");
  });

  it("reversal back to the measured origin retains an unset preference", () => {
    render(
      <div>
        <BottomTabsSplitter />
      </div>,
    );
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 280 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 300 });
    fireEvent.pointerUp(sep, { pointerId: 1 });
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBeNull();
  });
});
