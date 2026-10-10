import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { stubRaf } from "../test/raf";
import { stubResizeObserver } from "../test/resizeObserver";
import { BottomSheet } from "./BottomSheet";

describe("BottomSheet", () => {
  it("makes stowed controls inert and restores them when the sheet returns", () => {
    const props = {
      open: true,
      onClose: vi.fn(),
      title: "Inspector",
      backgroundPolicy: "interactive" as const,
    };
    const { rerender } = render(
      <BottomSheet {...props} stowed>
        <button type="button">Undo</button>
      </BottomSheet>,
    );
    const root = document.querySelector(".bottom-sheet-root");
    expect(root).toHaveAttribute("inert");
    expect(root).toHaveTextContent("Undo");
    rerender(
      <BottomSheet {...props} stowed={false}>
        <button type="button">Undo</button>
      </BottomSheet>,
    );
    expect(root).not.toHaveAttribute("inert");
    expect(root).toHaveTextContent("Undo");
    rerender(
      <BottomSheet {...props}>
        <button type="button">Undo</button>
      </BottomSheet>,
    );
    expect(root).not.toHaveAttribute("inert");
  });

  it("renders compact header actions beside its resize and close controls", async () => {
    render(
      <BottomSheet
        open
        onClose={() => undefined}
        backgroundPolicy="interactive"
        title="Trim start"
        drawer={{
          detents: ["peek", "half"],
          detent: "peek",
          onDetentChange: vi.fn(),
          label: "Inspector height",
        }}
        compactHeaderActions={<button type="button">Undo</button>}
        compactResizeIcons
      >
        <p>Inspector body</p>
      </BottomSheet>,
    );

    expect(screen.getByRole("button", { name: "Undo" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Expand to half height" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Expand to half height" }),
    ).toHaveAttribute("title", "Expand to half height");
    expect(screen.getByRole("button", { name: "Close" })).toBeVisible();
    await expectNoA11yViolations(document.body);
  });

  it("opens from its trigger, toggles controlled sizing, and restores focus on close and Escape", async () => {
    const user = userEvent.setup();
    const onExpandedChange = vi.fn();
    function ControlledSheet() {
      const [open, setOpen] = useState(false);
      const [expanded, setExpanded] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open inspector
          </button>
          <BottomSheet
            open={open}
            onClose={() => setOpen(false)}
            backgroundPolicy="interactive"
            title="Inspector"
            expanded={expanded}
            onExpandedChange={(next) => {
              onExpandedChange(next);
              setExpanded(next);
            }}
          >
            <p>Inspector details</p>
          </BottomSheet>
        </>
      );
    }

    render(<ControlledSheet />);
    const trigger = screen.getByRole("button", { name: "Open inspector" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Inspector" });
    const close = screen.getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toHaveFocus());
    expect(dialog).toHaveClass("bottom-sheet--half");
    expect(dialog.querySelector(".bottom-sheet-grab")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expand" }));
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);
    expect(dialog).toHaveClass("bottom-sheet--full");
    await expectNoA11yViolations(dialog);
    await user.click(screen.getByRole("button", { name: "Collapse" }));
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
    expect(dialog).toHaveClass("bottom-sheet--half");
    await expectNoA11yViolations(dialog);

    await user.click(close);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();

    await user.click(trigger);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <BottomSheet
        open={false}
        onClose={() => undefined}
        backgroundPolicy="interactive"
        title="Details"
      >
        <p>Body</p>
      </BottomSheet>,
    );
    expect(container.querySelector(".bottom-sheet")).toBeNull();
    expect(document.querySelector(".bottom-sheet")).toBeNull();
  });

  it("shows dialog with close and is axe-clean", async () => {
    const onClose = vi.fn();
    render(
      <BottomSheet
        open
        onClose={onClose}
        backgroundPolicy="interactive"
        title="Details"
      >
        <p>Body content</p>
      </BottomSheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Details" });
    expect(dialog).toBeTruthy();
    await expectNoA11yViolations(dialog);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("dismisses on Escape", async () => {
    const onClose = vi.fn();
    render(
      <BottomSheet
        open
        onClose={onClose}
        backgroundPolicy="interactive"
        title="Details"
      >
        <p>Body</p>
      </BottomSheet>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("lets the canvas receive input with an interactive background", async () => {
    const onClose = vi.fn();
    const onCanvasClick = vi.fn();
    render(
      <>
        <button type="button" onClick={onCanvasClick}>
          Timeline canvas
        </button>
        <BottomSheet
          open
          onClose={onClose}
          backgroundPolicy="interactive"
          title="Inspector"
        >
          <p>Inspector body</p>
        </BottomSheet>
      </>,
    );
    const scrim = document.querySelector(
      ".bottom-sheet-scrim--interactive",
    ) as HTMLElement;
    expect(scrim.getAttribute("aria-hidden")).toBe("true");
    expect(scrim.classList).toContain("bottom-sheet-scrim--interactive");
    await userEvent.click(
      screen.getByRole("button", { name: "Timeline canvas" }),
    );
    expect(onCanvasClick).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    await expectNoA11yViolations(
      screen.getByRole("dialog", { name: "Inspector" }),
    );
  });

  it("leaves the timeline undimmed at the strip and dims it at half and full", () => {
    const scrimClear = () =>
      document
        .querySelector(".bottom-sheet-scrim--interactive")
        ?.classList.contains("bottom-sheet-scrim--clear");
    const sheet = (size: "peek" | "half" | "full") => (
      <BottomSheet
        open
        onClose={() => undefined}
        backgroundPolicy="interactive"
        title="Inspector"
        size={size}
      >
        <p>Inspector body</p>
      </BottomSheet>
    );
    const { rerender } = render(sheet("peek"));
    expect(scrimClear()).toBe(true);
    rerender(sheet("half"));
    expect(scrimClear()).toBe(false);
    rerender(sheet("full"));
    expect(scrimClear()).toBe(false);
  });

  it("keeps the dismiss scrim interactive for confirmations", async () => {
    const onClose = vi.fn();
    render(
      <BottomSheet
        open
        onClose={onClose}
        backgroundPolicy="dismiss"
        title="Confirm blade cut"
      >
        <p>Confirm this cut?</p>
      </BottomSheet>,
    );
    await expectNoA11yViolations(
      screen.getByRole("dialog", { name: "Confirm blade cut" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps fixed sheets closable without a resize action or drag cue", async () => {
    render(
      <BottomSheet
        open
        onClose={() => undefined}
        backgroundPolicy="dismiss"
        title="Fixed confirmation"
      >
        <p>Confirm this action?</p>
      </BottomSheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Fixed confirmation" });
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
    expect(dialog.querySelector(".bottom-sheet-grab")).toBeNull();
    await expectNoA11yViolations(dialog);
  });

  it("pads the drawer's scroll by its pinned chrome, so a revealed control clears it", () => {
    stubResizeObserver({ reportOnObserve: true });
    const offset = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("bottom-sheet-chrome") ? 72 : 0;
      });
    render(
      <BottomSheet
        open
        onClose={() => undefined}
        backgroundPolicy="interactive"
        title="Trim start"
        drawer={{
          detents: ["peek", "half", "full"],
          detent: "half",
          onDetentChange: () => undefined,
          label: "Inspector height",
        }}
      >
        <p>Fields</p>
      </BottomSheet>,
    );
    expect(
      screen
        .getByRole("dialog", { name: "Trim start" })
        .style.getPropertyValue("--sheet-chrome-block-size"),
    ).toBe("72px");
    offset.mockRestore();
    vi.unstubAllGlobals();
  });

  describe("as a swipeable drawer (#1051 round 4b)", () => {
    let commits = 0;
    function Drawer({ start = "peek" }: { start?: "peek" | "half" | "full" }) {
      const [detent, setDetent] = useState<"peek" | "half" | "full">(start);
      return (
        <Profiler id="sheet" onRender={() => (commits += 1)}>
          <BottomSheet
            open
            onClose={() => undefined}
            backgroundPolicy="interactive"
            title="Trim start"
            drawer={{
              detents: ["peek", "half", "full"],
              detent,
              onDetentChange: setDetent,
              label: "Inspector height",
            }}
          >
            <p>{detent}</p>
          </BottomSheet>
        </Profiler>
      );
    }
    const chrome = () =>
      document.querySelector(".bottom-sheet-chrome") as HTMLElement;
    const dialog = () => screen.getByRole("dialog", { name: "Trim start" });
    /** A 600px slot: strip 100, half 300, full 600; the header is 50. */
    function layOut() {
      const height = (el: HTMLElement) => {
        if (el.classList.contains("bottom-sheet-chrome")) return 50;
        if (!el.classList.contains("bottom-sheet")) return 0;
        if (el.style.height === "100%") return 600;
        if (el.classList.contains("bottom-sheet--full")) return 600;
        return el.classList.contains("bottom-sheet--half") ? 300 : 100;
      };
      const offset = vi
        .spyOn(HTMLElement.prototype, "offsetHeight", "get")
        .mockImplementation(function (this: HTMLElement) {
          return height(this);
        });
      const rect = vi
        .spyOn(Element.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: Element) {
          const tall = this.classList.contains("bottom-sheet-root") ? 600 : 0;
          return DOMRect.fromRect({ width: 390, height: tall });
        });
      return () => {
        offset.mockRestore();
        rect.mockRestore();
      };
    }
    /** A pointer event at `t` ms: jsdom stamps events with the wall clock. */
    const pointer = (
      type: "pointerDown" | "pointerMove" | "pointerUp",
      y: number,
      t: number,
      pointerId = 5,
    ) => {
      const event = createEvent[type](chrome(), { pointerId, clientY: y });
      Object.defineProperty(event, "timeStamp", { value: t });
      fireEvent(chrome(), event);
    };
    const press = (y: number, t: number, pointerId = 5) =>
      pointer("pointerDown", y, t, pointerId);
    const move = (y: number, t: number) => pointer("pointerMove", y, t);
    const lift = (y: number, t: number) => pointer("pointerUp", y, t);

    it("follows the finger by transform, a frame at a time, with no render", () => {
      const raf = stubRaf();
      const restore = layOut();
      try {
        render(<Drawer />);
        commits = 0;
        press(500, 1000);
        // The strip (100px) fills its 600px slot, drawn 500px down.
        expect(dialog().style.transform).toBe("translateY(500px)");
        move(470, 1016);
        move(440, 1032);
        expect(dialog().style.transform).toBe("translateY(500px)");
        raf.fire(1033);
        expect(dialog().style.transform).toBe("translateY(440px)");
        expect(commits).toBe(0);
      } finally {
        restore();
        vi.unstubAllGlobals();
      }
    });

    it("opens fully on a quick flick and lands a slow drag at the nearest detent", () => {
      const raf = stubRaf();
      const restore = layOut();
      try {
        render(<Drawer />);
        // 40px up in 30 ms: 1.33 px/ms coasts the 140px strip past full.
        press(500, 1000);
        move(490, 1010);
        move(470, 1020);
        move(460, 1030);
        lift(460, 1035);
        expect(dialog()).toHaveClass("bottom-sheet--full");
        raf.fire(1050);
        expect(dialog().style.transform).toBe("");

        // Down to 220px, held, then lifted: half (300) is nearest.
        cleanup();
        render(<Drawer />);
        press(500, 2000);
        move(450, 2200);
        move(400, 2400);
        move(380, 2600);
        lift(380, 2900);
        expect(dialog()).toHaveClass("bottom-sheet--half");
        raf.fire(2920);
        expect(dialog().style.transform).toBe("");
        expect(dialog().style.height).toBe("");
      } finally {
        restore();
        vi.unstubAllGlobals();
      }
    });

    it("drops a swipe a second finger joins", () => {
      const raf = stubRaf();
      const restore = layOut();
      try {
        render(<Drawer />);
        press(500, 1000);
        move(420, 1020);
        raf.fire(1021);
        expect(dialog().style.transform).toBe("translateY(420px)");
        press(300, 1030, 6);
        lift(420, 1040);
        raf.fire(1041);
        expect(dialog().style.transform).toBe("");
        expect(dialog()).toHaveClass("bottom-sheet--peek");
      } finally {
        restore();
        vi.unstubAllGlobals();
      }
    });

    describe("when the sheet stops being a drawer", () => {
      const sheet = (drawer: boolean, open = true) => (
        <BottomSheet
          open={open}
          onClose={() => undefined}
          backgroundPolicy="interactive"
          title="Trim start"
          drawer={
            drawer
              ? {
                  detents: ["peek", "half", "full"],
                  detent: "peek",
                  onDetentChange: () => undefined,
                  label: "Inspector height",
                }
              : undefined
          }
        >
          <p>Fields</p>
        </BottomSheet>
      );
      const dragStyles = () => ({
        motion: dialog().getAttribute("data-drawer-motion"),
        height: dialog().style.height,
        transform: dialog().style.transform,
      });
      const atRest = { motion: null, height: "", transform: "" };

      it("clears the drag styles a finger left on it", () => {
        const raf = stubRaf();
        const restore = layOut();
        try {
          const view = render(sheet(true));
          press(500, 1000);
          move(420, 1020);
          raf.fire(1021);
          expect(dragStyles()).toEqual({
            motion: "drag",
            height: "100%",
            transform: "translateY(420px)",
          });
          view.rerender(sheet(false));
          raf.fire(1100);
          expect(dragStyles()).toEqual(atRest);
        } finally {
          restore();
          vi.unstubAllGlobals();
        }
      });

      it("clears the drag styles when the sheet closes mid-drag, though it still has a drawer", () => {
        const raf = stubRaf();
        const restore = layOut();
        try {
          const view = render(sheet(true));
          const panel = dialog();
          press(500, 1000);
          move(420, 1020);
          raf.fire(1021);
          expect(panel.getAttribute("data-drawer-motion")).toBe("drag");
          view.rerender(sheet(true, false));
          raf.fire(1100);
          expect({
            motion: panel.getAttribute("data-drawer-motion"),
            height: panel.style.height,
            transform: panel.style.transform,
          }).toEqual(atRest);
        } finally {
          restore();
          vi.unstubAllGlobals();
        }
      });
    });

    it("keeps Expand and Collapse, and a named range for keys and screen readers", async () => {
      render(<Drawer start="half" />);
      expect(
        screen.getByRole("button", { name: "Expand to full height" }),
      ).toBeVisible();
      const range = screen.getByRole("slider", { name: "Inspector height" });
      expect(range).toHaveAttribute("aria-valuetext", "Half height");
      fireEvent.change(range, { target: { value: "2" } });
      expect(dialog()).toHaveClass("bottom-sheet--full");
      expect(screen.queryByRole("button", { name: /^Expand/ })).toBeNull();
      await userEvent.click(
        screen.getByRole("button", { name: "Collapse to strip" }),
      );
      expect(dialog()).toHaveClass("bottom-sheet--peek");
      await expectNoA11yViolations(dialog());
    });
  });

  it("peeks as a strip, expands one size up with named actions, and stows without losing focus", async () => {
    const user = userEvent.setup();
    function Strip({ stowed }: { stowed: boolean }) {
      const [expanded, setExpanded] = useState(false);
      return (
        <BottomSheet
          open
          onClose={() => undefined}
          backgroundPolicy="interactive"
          title="Fade in"
          size="peek"
          expandedSize="half"
          expanded={expanded}
          onExpandedChange={setExpanded}
          resizeLabels={{
            expand: "Expand to the full inspector",
            collapse: "Collapse to the strip",
          }}
          stowed={stowed}
        >
          <p>300 ms</p>
        </BottomSheet>
      );
    }
    const { rerender } = render(<Strip stowed={false} />);
    const dialog = screen.getByRole("dialog", { name: "Fade in" });
    expect(dialog).toHaveClass("bottom-sheet--peek");
    await expectNoA11yViolations(dialog);
    await user.click(
      screen.getByRole("button", { name: "Expand to the full inspector" }),
    );
    expect(dialog).toHaveClass("bottom-sheet--half");
    const collapse = screen.getByRole("button", {
      name: "Collapse to the strip",
    });
    collapse.focus();
    rerender(<Strip stowed />);
    expect(dialog.closest(".bottom-sheet-root")).toHaveClass("is-stowed");
    expect(collapse).toHaveFocus();
    rerender(<Strip stowed={false} />);
    expect(dialog.closest(".bottom-sheet-root")).not.toHaveClass("is-stowed");
    await user.click(collapse);
    expect(dialog).toHaveClass("bottom-sheet--peek");
  });
});
