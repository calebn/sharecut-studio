import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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
    onCollapse: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <div className="bottom-tabs" style={{ height: 200 }}>
      <BottomTabsSplitterView {...props} />
    </div>,
  );
  return { ...utils, props };
}

/** Applies each requested height the way the live adapter does, so a drag sees its own paint. */
function renderLiveSplitter(heightRem = 12.5) {
  const onCollapse = vi.fn();
  const onResize = vi.fn();
  function Live() {
    const [height, setHeight] = useState(heightRem);
    return (
      <div className="bottom-tabs" style={{ height: 200 }}>
        <BottomTabsSplitterView
          heightRem={height}
          minRem={8}
          maxRem={24}
          userSet
          onResize={(rem) => {
            onResize(rem);
            setHeight(Math.min(24, Math.max(8, rem)));
          }}
          onReset={vi.fn()}
          onCollapse={onCollapse}
        />
      </div>
    );
  }
  render(<Live />);
  return { onCollapse, onResize };
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
      expect(observer.targets).toEqual([
        panel,
        separator.querySelector(".splitter-rem-signal"),
      ]);
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
      "Drag or arrows to resize · Shift for larger steps · End or drag past the bottom collapses · Escape cancels · Enter or double-click resets",
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

  it("Home jumps to max, End collapses, and Enter or double-click resets", async () => {
    const { props } = renderSplitter();
    const sep = screen.getByRole("separator", {
      name: "Resize editor panels",
    });
    sep.focus();
    await userEvent.keyboard("{Home}");
    expect(props.onResize).toHaveBeenLastCalledWith(24);
    await userEvent.keyboard("{End}");
    expect(props.onCollapse).toHaveBeenCalledTimes(1);
    expect(props.onResize).toHaveBeenCalledTimes(1);
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

  it("clamps visible steps before no-op and never nests controls in the separator", () => {
    const { props } = renderSplitter({ userSet: false, minRem: 8, maxRem: 24 });
    const sep = screen.getByRole("separator");
    const rect = vi
      .spyOn(sep.parentElement!, "getBoundingClientRect")
      .mockReturnValue({ height: 128 } as DOMRect);
    fireEvent.click(screen.getByRole("button", { name: "Shorter" }));
    expect(props.onResize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Taller" }));
    expect(props.onResize).toHaveBeenLastCalledWith(9);
    rect.mockReturnValue({ height: 384 } as DOMRect);
    fireEvent.click(screen.getByRole("button", { name: "Taller" }));
    expect(props.onResize).toHaveBeenCalledTimes(1);
    expect(sep.querySelector("button")).toBeNull();
    rect.mockRestore();
  });

  it.each([
    { heightRem: 8, name: "Shorter", other: "Taller", next: 9 },
    { heightRem: 24, name: "Taller", other: "Shorter", next: 23 },
  ])(
    "explains a panel size limit at $heightRem rem",
    ({ heightRem, name, other, next }) => {
      const { props } = renderSplitter({
        userSet: true,
        heightRem,
        minRem: 8,
        maxRem: 24,
      });
      expect(screen.getByRole("button", { name })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: other }));
      expect(props.onResize).toHaveBeenCalledExactlyOnceWith(next);
    },
  );

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
      onCollapse: vi.fn(),
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
          onCollapse={vi.fn()}
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
          onCollapse={vi.fn()}
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
          onCollapse={vi.fn()}
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

  it("collapses on release past the minimum and shows the pending state while armed", () => {
    const props = renderLiveSplitter();
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 380 });
    expect(sep).not.toHaveAttribute("data-collapse-armed");
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 420 });
    expect(sep).toHaveAttribute("data-collapse-armed");
    expect(sep).toHaveAttribute("aria-valuetext", "Release to collapse");
    expect(props.onCollapse).not.toHaveBeenCalled();
    fireEvent.pointerUp(sep, { pointerId: 1 });
    expect(props.onCollapse).toHaveBeenCalledTimes(1);
    expect(sep).not.toHaveAttribute("data-collapse-armed");
  });

  it("releases a drag inside the overshoot band at the minimum without collapsing", () => {
    const props = renderLiveSplitter();
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 380 });
    expect(props.onResize).toHaveBeenLastCalledWith(8);
    fireEvent.pointerUp(sep, { pointerId: 1 });
    expect(props.onCollapse).not.toHaveBeenCalled();
  });

  it("collapses a drag that starts at the minimum and never paints a new height", () => {
    const props = renderLiveSplitter(8);
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 340 });
    expect(sep).toHaveAttribute("data-collapse-armed");
    fireEvent.pointerUp(sep, { pointerId: 1 });
    expect(props.onResize).not.toHaveBeenCalled();
    expect(props.onCollapse).toHaveBeenCalledTimes(1);
  });

  it("Escape and pointer cancel cancel an armed drag without collapsing", () => {
    const props = renderLiveSplitter();
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 440 });
    fireEvent.keyDown(sep, { key: "Escape" });
    fireEvent.pointerUp(sep, { pointerId: 1 });
    expect(props.onCollapse).not.toHaveBeenCalled();
    fireEvent.pointerDown(sep, { pointerId: 2, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 2, clientY: 440 });
    fireEvent.pointerCancel(sep, { pointerId: 2 });
    expect(props.onCollapse).not.toHaveBeenCalled();
    expect(sep).not.toHaveAttribute("data-collapse-armed");
  });

  it("keeps following the pointer after Safari drops pointer capture", () => {
    const props = renderLiveSplitter();
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 280 });
    fireEvent.lostPointerCapture(sep, { pointerId: 1 });
    const painted = props.onResize.mock.calls.length;
    fireEvent.pointerMove(document.body, { pointerId: 1, clientY: 260 });
    expect(props.onResize.mock.calls.length).toBeGreaterThan(painted);
    fireEvent.pointerUp(document.body, { pointerId: 1 });
    fireEvent.pointerDown(sep, { pointerId: 2, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 2, clientY: 250 });
    expect(props.onResize.mock.calls.length).toBeGreaterThan(painted + 1);
  });

  it("restores the height from before a drag whose release was dropped", () => {
    const props = renderLiveSplitter();
    const sep = screen.getByRole("separator", { name: "Resize editor panels" });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 280 });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 280 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 260 });
    fireEvent.keyDown(sep, { key: "Escape" });
    expect(props.onResize.mock.calls.at(-1)?.[0]).toBe(12.5);
  });
});
