import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { FakeResizeObserver, stubResizeObserver } from "../test/resizeObserver";
import {
  BottomTabsSplitterView,
  type BottomTabsSplitterViewProps,
} from "./BottomTabsSplitterView";

function renderSplitter(overrides: Partial<BottomTabsSplitterViewProps> = {}) {
  const props: BottomTabsSplitterViewProps = {
    heightRem: 12.5,
    minRem: 8,
    maxRem: 24,
    userSet: true,
    onResize: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <div className="bottom-tabs" style={{ height: 200 }}>
      <BottomTabsSplitterView {...props} />
    </div>,
  );
  return { ...utils, props };
}

describe("BottomTabsSplitterView", () => {
  it("reports the responsive panel's measured height without creating a preference", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ height: 423 } as DOMRect);
    stubResizeObserver();
    let unmount: (() => void) | undefined;
    try {
      const rendered = renderSplitter({ userSet: false, heightRem: 12.5 });
      const { props, rerender } = rendered;
      unmount = rendered.unmount;
      const separator = screen.getByRole("separator", {
        name: "Resize editor panels",
      });
      expect(separator).toHaveAttribute("aria-valuenow", "26.4");
      expect(separator).toHaveAttribute("aria-valuetext", "26.4 rem");
      const panel = separator.parentElement;
      expect(panel).not.toBeNull();
      if (!panel) throw new Error("separator has no panel parent");
      const observer = FakeResizeObserver.of(panel);
      expect(observer.targets).toEqual([panel]);
      rect.mockReturnValue({ height: 384 } as DOMRect);
      act(() => observer.fire());
      expect(separator).toHaveAttribute("aria-valuenow", "24");
      rerender(
        <div className="bottom-tabs" style={{ height: 200 }}>
          <BottomTabsSplitterView {...props} heightRem={14} />
        </div>,
      );
      expect(FakeResizeObserver.all).toEqual([observer]);
      expect(observer.disconnected).toBe(false);
      expect(separator).toHaveAttribute("aria-valuenow", "24");
      rendered.unmount();
      expect(observer.disconnected).toBe(true);
      expect(props.onResize).not.toHaveBeenCalled();
      expect(props.onReset).not.toHaveBeenCalled();
    } finally {
      unmount?.();
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("renders an accessible horizontal separator from props", async () => {
    const { container } = renderSplitter();
    const sep = screen.getByRole("separator", {
      name: "Resize editor panels",
    });
    expect(sep.getAttribute("aria-orientation")).toBe("horizontal");
    expect(sep.getAttribute("aria-valuemin")).toBe("8");
    expect(sep.getAttribute("aria-valuemax")).toBe("24");
    expect(sep.getAttribute("aria-valuenow")).toBe("12.5");
    expect(sep.getAttribute("aria-valuetext")).toBe("12.5 rem");
    expect(sep.getAttribute("tabindex")).toBe("0");
    expect(sep.getAttribute("title")).toBe(
      "Drag or arrows to resize · Shift for larger steps · Escape cancels · Enter or double-click resets",
    );
    await expectNoA11yViolations(container);
  });

  it("steps with arrows from the stored height", async () => {
    const { props } = renderSplitter({ userSet: true, heightRem: 14 });
    const sep = screen.getByRole("separator", {
      name: "Resize editor panels",
    });
    sep.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(props.onResize).toHaveBeenLastCalledWith(14.25);
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(props.onResize).toHaveBeenLastCalledWith(13);
  });

  it("Home/End jump to max/min and Enter or double-click resets", async () => {
    const { props } = renderSplitter();
    const sep = screen.getByRole("separator", {
      name: "Resize editor panels",
    });
    sep.focus();
    await userEvent.keyboard("{Home}");
    expect(props.onResize).toHaveBeenLastCalledWith(24);
    await userEvent.keyboard("{End}");
    expect(props.onResize).toHaveBeenLastCalledWith(8);
    await userEvent.keyboard("{Enter}");
    expect(props.onReset).toHaveBeenCalledTimes(1);
    await userEvent.dblClick(sep);
    expect(props.onReset).toHaveBeenCalledTimes(2);
  });

  it("seeds keyboard steps from the measured panel without a preference", async () => {
    const { props } = renderSplitter({ userSet: false });
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
    expect(props.onResize).toHaveBeenLastCalledWith(20.25);
  });

  it("drags by pointer delta and stops after pointer up", () => {
    const { props } = renderSplitter({ heightRem: 12.5 });
    const sep = screen.getByRole("separator", {
      name: "Resize editor panels",
    });
    fireEvent.pointerDown(sep, { pointerId: 1, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 280 });
    expect(props.onResize).toHaveBeenLastCalledWith(13.75);
    fireEvent.pointerUp(sep);
    const callCount = (props.onResize as ReturnType<typeof vi.fn>).mock.calls
      .length;
    fireEvent.pointerMove(sep, { clientY: 200 });
    expect((props.onResize as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callCount,
    );
  });

  it("keeps handled keys from bubbling", async () => {
    const parentKeys: string[] = [];
    const props: BottomTabsSplitterViewProps = {
      heightRem: 12.5,
      minRem: 8,
      maxRem: 24,
      userSet: true,
      onResize: vi.fn(),
      onReset: vi.fn(),
    };
    render(
      <div
        role="presentation"
        onKeyDown={(e) => {
          parentKeys.push(e.key);
        }}
      >
        <div className="bottom-tabs" style={{ height: 200 }}>
          <BottomTabsSplitterView {...props} />
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
  it("leaves a newer external height intact when the owner is canceled", () => {
    const onResize = vi.fn();
    const onReset = vi.fn();
    const { rerender } = renderSplitter({ onResize, onReset });
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 280 });
    expect(onResize).toHaveBeenLastCalledWith(13.75);
    rerender(
      <div className="bottom-tabs" style={{ height: 200 }}>
        <BottomTabsSplitterView
          heightRem={22}
          minRem={8}
          maxRem={24}
          userSet
          onResize={onResize}
          onReset={onReset}
        />
      </div>,
    );
    fireEvent.keyDown(sep, { key: "Escape" });
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onReset).not.toHaveBeenCalled();
  });

  it("rejects non-left mouse admission and clamps each preview", () => {
    const { props } = renderSplitter();
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, {
      pointerId: 1,
      pointerType: "mouse",
      button: 2,
      clientY: 300,
    });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 280 });
    expect(props.onResize).not.toHaveBeenCalled();
    fireEvent.pointerDown(sep, {
      pointerId: 2,
      pointerType: "mouse",
      button: 0,
      clientY: 300,
    });
    fireEvent.pointerMove(sep, { pointerId: 2, clientY: -500 });
    expect(props.onResize).toHaveBeenLastCalledWith(24);
  });
  it("does not paint over an external height change before the first movement", () => {
    const onResize = vi.fn();
    const onReset = vi.fn();
    const { rerender } = renderSplitter({ onResize, onReset });
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    rerender(
      <div className="bottom-tabs" style={{ height: 200 }}>
        <BottomTabsSplitterView
          heightRem={22}
          minRem={8}
          maxRem={24}
          userSet
          onResize={onResize}
          onReset={onReset}
        />
      </div>,
    );
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 280 });
    fireEvent.pointerCancel(sep, { pointerId: 1 });
    expect(onResize).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });
  it("consumes splitter keys during pointer ownership without changing its preview", () => {
    const parentKeys: string[] = [];
    const onResize = vi.fn();
    render(
      <div
        role="presentation"
        onKeyDown={(event) => parentKeys.push(event.key)}
      >
        <BottomTabsSplitterView
          heightRem={12.5}
          minRem={8}
          maxRem={24}
          userSet
          onResize={onResize}
          onReset={vi.fn()}
        />
      </div>,
    );
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End", "Enter"])
      fireEvent.keyDown(sep, { key });
    expect(parentKeys).toEqual([]);
    expect(onResize).not.toHaveBeenCalled();
  });
});
