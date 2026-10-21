import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CSSProperties } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { TABS_HEIGHT_STORAGE_KEY } from "../hooks/useTabsHeight";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { FakeResizeObserver, stubResizeObserver } from "../test/resizeObserver";
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

  it("restores a default on owner cancellation and leaves a no-op preference unset", () => {
    render(
      <div>
        <BottomTabsSplitter />
      </div>,
    );
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 280 });
    fireEvent.pointerCancel(sep, { pointerId: 1 });
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

  it("steps from measured default, persists across remount and resets without project changes", async () => {
    const before = useDawStore.getState().project;
    const { unmount } = render(
      <div className="bottom-tabs">
        <BottomTabsSplitter />
      </div>,
    );
    const sep = screen.getByRole("separator");
    expect(sep.parentElement).toHaveClass("bottom-tabs");
    const rect = vi
      .spyOn(sep.parentElement!, "getBoundingClientRect")
      .mockReturnValue({ height: 256 } as DOMRect);
    await userEvent.click(screen.getByRole("button", { name: "Taller" }));
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe("17");
    rect.mockReturnValue({ height: 272 } as DOMRect);
    await userEvent.click(screen.getByRole("button", { name: "Shorter" }));
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe("16");
    rect.mockRestore();
    unmount();
    render(
      <div className="bottom-tabs">
        <BottomTabsSplitter />
      </div>,
    );
    expect(
      document.documentElement.style.getPropertyValue("--tabs-height"),
    ).toBe("16rem");
    await userEvent.click(
      screen.getByRole("button", { name: "Reset panel size" }),
    );
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBeNull();
    expect(
      document.documentElement.style.getPropertyValue("--tabs-height"),
    ).toBe("");
    expect(useDawStore.getState().project).toBe(before);
  });

  it("a size button during a drag restores the preference and cannot commit a step", () => {
    localStorage.setItem(TABS_HEIGHT_STORAGE_KEY, "18");
    render(<BottomTabsSplitter />);
    const sep = screen.getByRole("separator");
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 268 });
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe("20");
    const taller = screen.getByRole("button", { name: "Taller" });
    fireEvent.pointerDown(taller, { pointerId: 2, button: 0 });
    fireEvent.click(taller);
    fireEvent.pointerUp(sep, { pointerId: 1 });
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe("18");
    fireEvent.pointerDown(taller, { pointerId: 3, button: 0 });
    fireEvent.click(taller);
    expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe("19");
  });

  describe("collapse to the tool rail", () => {
    beforeEach(() => {
      clearRegisteredCommands();
      registerDawCommands();
      useDawStore.setState({ layoutMode: "default" });
    });

    it("End runs Maximize timeline and keeps the stored height", async () => {
      window.localStorage.setItem(TABS_HEIGHT_STORAGE_KEY, "18");
      render(<BottomTabsSplitter />);
      const sep = screen.getByRole("separator", {
        name: "Resize editor panels",
      });
      sep.focus();
      await userEvent.keyboard("{End}");
      await vi.waitFor(() =>
        expect(useDawStore.getState().layoutMode).toBe("timeline"),
      );
      expect(window.localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe("18");
    });

    it("dragging below the minimum collapses and reopening returns to the height held before the drag", async () => {
      window.localStorage.setItem(TABS_HEIGHT_STORAGE_KEY, "18");
      render(<BottomTabsSplitter />);
      const sep = screen.getByRole("separator", {
        name: "Resize editor panels",
      });
      fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
      fireEvent.pointerMove(sep, { pointerId: 1, clientY: 560 });
      expect(window.localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe("8");
      fireEvent.pointerUp(sep, { pointerId: 1 });
      await vi.waitFor(() =>
        expect(useDawStore.getState().layoutMode).toBe("timeline"),
      );
      expect(window.localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe("18");
      expect(
        document.documentElement.style.getPropertyValue("--tabs-height"),
      ).toBe("18rem");
    });
  });
});

describe("measured shell panel bounds", () => {
  it.each([null, "12"])(
    "uses live geometry and preserves passive preference %s",
    (stored) => {
      stubResizeObserver();
      const root = document.documentElement;
      root.style.fontSize = "24px";
      root.style.removeProperty("--tabs-height");
      localStorage.removeItem(TABS_HEIGHT_STORAGE_KEY);
      if (stored) localStorage.setItem(TABS_HEIGHT_STORAGE_KEY, stored);
      const windowHeight = vi
        .spyOn(window, "innerHeight", "get")
        .mockReturnValue(600);
      let budgetPx = 426;
      const rect = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          const remPx = Number.parseFloat(root.style.fontSize);
          const requested =
            Number.parseFloat(root.style.getPropertyValue("--tabs-height")) ||
            12.5;
          const panelPx = Math.min(requested * remPx, budgetPx - 7.5 * remPx);
          return {
            height: this.classList.contains("bottom-tabs")
              ? panelPx
              : this.classList.contains("daw-main")
                ? budgetPx - panelPx
                : 600,
          } as DOMRect;
        });
      const before = useDawStore.getState().project;
      const view = render(
        <div
          className="daw-shell"
          style={{ "--shell-main-min-height": "7.5rem" } as CSSProperties}
        >
          <main className="daw-main" />
          <div className="bottom-tabs">
            <BottomTabsSplitter />
          </div>
        </div>,
      );
      try {
        const sep = screen.getByRole("separator");
        const panel = sep.parentElement!;
        const observer = FakeResizeObserver.of(panel);
        expect(observer.targets).toHaveLength(4);
        expect(sep).toHaveAttribute("aria-valuenow", "10.3");
        expect(sep).toHaveAttribute("aria-valuemax", "10.3");
        expect(sep).toHaveAttribute("aria-valuemin", "4.5");
        expect(screen.getByRole("button", { name: "Taller" })).toBeDisabled();
        expect(
          screen.getByRole("button", { name: "Taller" }),
        ).toHaveAccessibleDescription("Panel is at its tallest size.");
        fireEvent.keyDown(sep, { key: "Home" });
        fireEvent.keyDown(sep, { key: "ArrowUp", shiftKey: true });
        fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
        fireEvent.pointerMove(sep, { pointerId: 1, clientY: 280 });
        fireEvent.pointerUp(sep, { pointerId: 1 });
        expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe(stored);
        for (const cancel of [
          () => fireEvent.keyDown(sep, { key: "Escape" }),
          () => fireEvent.pointerCancel(sep, { pointerId: 17 }),
          () => fireEvent.blur(sep),
        ]) {
          fireEvent.pointerDown(sep, {
            pointerId: 17,
            button: 0,
            clientY: 300,
          });
          fireEvent.pointerMove(sep, { pointerId: 17, clientY: 324 });
          expect(Number(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY))).toBe(
            9.25,
          );
          cancel();
          expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe(stored);
          expect(panel.getBoundingClientRect().height).toBe(246);
        }

        budgetPx = 450;
        act(() => observer.fire());
        expect(sep).toHaveAttribute("aria-valuenow", "11.3");
        expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe(stored);
        budgetPx = 426;
        act(() => observer.fire());
        root.style.fontSize = "20px";
        act(() => observer.fire(sep.querySelector(".splitter-rem-signal")!));
        expect(sep).toHaveAttribute("aria-valuenow", stored ?? "12.5");
        expect(sep).toHaveAttribute("aria-valuemax", "13.8");
        expect(sep).toHaveAttribute("aria-valuemin", "8");
        expect(screen.getByRole("button", { name: "Taller" })).toBeEnabled();
        expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBe(stored);
        root.style.fontSize = "24px";
        act(() => observer.fire());
        fireEvent.click(screen.getByRole("button", { name: "Shorter" }));
        expect(Number(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY))).toBe(
          9.25,
        );
        expect(panel.getBoundingClientRect().height).toBe(222);
        fireEvent.click(screen.getByRole("button", { name: "Taller" }));
        expect(Number(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY))).toBe(
          10.25,
        );
        expect(panel.getBoundingClientRect().height).toBe(246);
        fireEvent.pointerDown(sep, { pointerId: 2, button: 0, clientY: 300 });
        fireEvent.pointerMove(sep, { pointerId: 2, clientY: 324 });
        expect(Number(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY))).toBe(
          9.25,
        );
        fireEvent.pointerCancel(sep, { pointerId: 2 });
        expect(Number(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY))).toBe(
          10.25,
        );
        fireEvent.click(
          screen.getByRole("button", { name: "Reset panel size" }),
        );
        expect(localStorage.getItem(TABS_HEIGHT_STORAGE_KEY)).toBeNull();
        expect(root.style.getPropertyValue("--tabs-height")).toBe("");
        expect(useDawStore.getState().project).toBe(before);
        act(() => observer.fire());
        act(() => observer.fire());
        expect(FakeResizeObserver.all).toEqual([observer]);
      } finally {
        view.unmount();
        rect.mockRestore();
        windowHeight.mockRestore();
        root.style.removeProperty("font-size");
        root.style.removeProperty("--tabs-height");
        localStorage.removeItem(TABS_HEIGHT_STORAGE_KEY);
        vi.unstubAllGlobals();
      }
    },
  );
});
