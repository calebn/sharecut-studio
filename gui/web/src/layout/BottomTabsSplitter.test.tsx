import { render, screen } from "@testing-library/react";
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
});
