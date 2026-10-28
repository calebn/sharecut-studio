import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  type InspectorCardProps,
  type InspectorPhoneProps,
  type InspectorSection,
  InspectorSheet,
} from "./InspectorSheet";

const sections: InspectorSection[] = [
  {
    id: "timing",
    title: "Timing",
    rows: [
      {
        id: "start",
        label: "Start",
        control: <button type="button">Start field</button>,
      },
      { id: "end", control: <button type="button">End field</button> },
    ],
  },
  {
    id: "fades",
    title: "Fades",
    defaultCollapsed: true,
    rows: [
      {
        id: "in",
        label: "Fade in",
        control: <button type="button">Fade field</button>,
      },
    ],
  },
  {
    id: "loose",
    rows: [{ id: "gain", label: "Gain", control: <span>-2.5 dB</span> }],
  },
];

function card(over: Partial<InspectorCardProps> = {}) {
  const onClose = vi.fn();
  const props: InspectorCardProps = {
    form: "card",
    icon: "sliders-horizontal",
    name: "Maya",
    sections,
    anchor: { x: 600, y: 100, width: 80, height: 40 },
    bounds: { width: 1280, height: 800 },
    onClose,
    ...over,
  };
  const view = render(<InspectorSheet {...props} />);
  return { ...view, onClose };
}

const HEIGHTS = { dock: 64, half: 400, full: 736 };

function phone(over: Partial<InspectorPhoneProps> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onDetentChange: vi.fn(),
    onDismiss: vi.fn(),
  };
  const props: InspectorPhoneProps = {
    form: "phone",
    icon: "sliders-horizontal",
    name: "Maya",
    sections,
    dock: <button type="button">Hear</button>,
    detent: "dock",
    ...handlers,
    ...over,
  };
  const view = render(
    <div data-testid="host">
      <InspectorSheet {...props} />
    </div>,
  );
  Object.defineProperty(screen.getByTestId("host"), "clientHeight", {
    value: 800,
  });
  const sheet = screen.getByRole("dialog", { name: "Maya" });
  sheet.getBoundingClientRect = () =>
    ({ height: HEIGHTS[props.detent] }) as DOMRect;
  return { ...view, ...handlers, sheet };
}

const grip = () => screen.getByRole("slider", { name: "Sheet height" });
const at = (clientY: number, pointerId = 1) => ({
  pointerId,
  pointerType: "touch",
  clientX: 180,
  clientY,
});

const time = { ms: 0 };

/** The sheet reads its flick speed from performance.now; the tests set it before each move. */
function clock() {
  time.ms = 0;
  vi.spyOn(performance, "now").mockImplementation(() => time.ms);
}

function moveTo(clientY: number, ms: number, pointerId = 1) {
  time.ms = ms;
  fireEvent.pointerMove(grip(), at(clientY, pointerId));
}

const height = (sheet: HTMLElement) =>
  sheet.style.getPropertyValue("--sys-inspector-h");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InspectorSheet card", () => {
  it("is a non-modal dialog named for the object with the name, Close and no Apply", () => {
    card();
    const region = screen.getByRole("dialog", { name: "Maya" });
    expect(
      within(region).getByRole("heading", { level: 2, name: "Maya" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Close" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /apply|expand|collapse to/i }),
    ).toBeNull();
  });

  it("places 8 px below an anchor with room, centred on it, and 60 % tall at most", () => {
    card();
    const style = screen.getByRole("dialog", { name: "Maya" }).style;
    expect([
      style.insetInlineStart,
      style.insetBlockStart,
      style.maxBlockSize,
    ]).toEqual(["480px", "148px", "480px"]);
  });

  it("hangs from the anchor's top edge when it flips above", () => {
    card({ anchor: { x: 600, y: 600, width: 80, height: 40 } });
    const region = screen.getByRole("dialog", { name: "Maya" });
    expect(region).toHaveAttribute("data-side", "above");
    expect([region.style.insetBlockEnd, region.style.insetBlockStart]).toEqual([
      "208px",
      "",
    ]);
  });

  it("collapses a section by its heading button and starts a defaultCollapsed one closed", async () => {
    card();
    const timing = screen.getByRole("button", { name: "Timing" });
    const fades = screen.getByRole("button", { name: "Fades" });
    expect(timing).toHaveAttribute("aria-expanded", "true");
    expect(fades).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Fade field" })).toBeNull();
    await userEvent.click(fades);
    expect(fades).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Fade field" })).toBeVisible();
    await userEvent.click(timing);
    expect(screen.queryByRole("button", { name: "Start field" })).toBeNull();
    expect(
      document.getElementById(timing.getAttribute("aria-controls") ?? ""),
    ).toHaveAttribute("hidden");
  });

  it("gives a section with no title no heading, and an unlabelled row the whole width", () => {
    card();
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
    ).toEqual(["Timing", "Fades"]);
    expect(
      screen
        .getByRole("button", { name: "End field" })
        .closest(".sys-inspector-row"),
    ).toHaveAttribute("data-unlabelled");
  });

  it("tabs through Close, the headings and the controls in reading order", async () => {
    card();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Timing" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Start field" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "End field" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Fades" })).toHaveFocus();
  });

  it("closes with Close and with Escape from a control, and tells nobody else", async () => {
    const { onClose } = card();
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    screen.getByRole("button", { name: "Start field" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(heard).not.toHaveBeenCalled();
    window.removeEventListener("keydown", heard);
  });

  it("leaves Escape to a field that took it", () => {
    const { onClose } = card({
      sections: [
        {
          id: "a",
          rows: [
            {
              id: "x",
              control: (
                <input
                  aria-label="Typed"
                  onKeyDown={(event) => event.preventDefault()}
                />
              ),
            },
          ],
        },
      ],
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Typed" }), {
      key: "Escape",
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("has a plain heading without onRename and a Name field with it", () => {
    const { unmount } = card();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    unmount();
    card({ onRename: vi.fn() });
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Maya");
  });

  it("renames on Enter and on blur, trimmed, and puts the name back on Escape or an empty name", async () => {
    const onRename = vi.fn();
    const { onClose } = card({ onRename });
    const field = screen.getByRole("textbox", { name: "Name" });
    await userEvent.clear(field);
    await userEvent.type(field, "  Sam {Enter}");
    expect(onRename.mock.calls).toEqual([["Sam"]]);
    await userEvent.clear(field);
    await userEvent.type(field, "Kim");
    await userEvent.tab();
    expect(onRename.mock.calls).toEqual([["Sam"], ["Kim"]]);
    await userEvent.clear(field);
    await userEvent.type(field, "Zed{Escape}");
    expect(field).toHaveValue("Maya");
    await userEvent.clear(field);
    await userEvent.tab();
    expect(field).toHaveValue("Maya");
    expect(onRename).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves Enter and Escape to the input method while a composition is open", async () => {
    const onRename = vi.fn();
    card({ onRename });
    const field = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(field, { target: { value: "にほん" } });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(field, { key: "Escape", isComposing: true });
    fireEvent.keyDown(field, { key: "Escape", keyCode: 229 });
    expect(onRename).not.toHaveBeenCalled();
    expect(field).toHaveValue("にほん");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onRename.mock.calls).toEqual([["にほん"]]);
  });

  it("has no axe violations", async () => {
    const { container } = card({ onRename: vi.fn() });
    await expectNoA11yViolations(container);
  });
});

describe("InspectorSheet phone", () => {
  it("is a vertical slider named Sheet height with the detent as its text", () => {
    const { sheet } = phone({ detent: "half" });
    expect(grip()).toHaveAttribute("aria-valuenow", "1");
    expect(grip()).toHaveAttribute("aria-valuetext", "Half height");
    expect(grip()).toHaveAttribute("aria-orientation", "vertical");
    expect(grip()).toHaveAttribute("tabindex", "0");
    expect(sheet).toHaveAttribute("data-detent", "half");
  });

  it("makes the content inert at the dock only", () => {
    const first = phone();
    expect(
      first.container.querySelector(".sys-inspector-content"),
    ).toHaveAttribute("inert");
    first.unmount();
    const second = phone({ detent: "half" });
    expect(
      second.container.querySelector(".sys-inspector-content"),
    ).not.toHaveAttribute("inert");
  });

  it("shows the host's dock above the header", () => {
    phone();
    expect(screen.getByRole("button", { name: "Hear" })).toBeVisible();
  });

  it("toggles half and dock on a tap and steps full down to half", () => {
    const first = phone({ detent: "dock" });
    fireEvent.click(grip(), { detail: 1 });
    expect(first.onDetentChange.mock.calls).toEqual([["half"]]);
    first.unmount();
    const second = phone({ detent: "half" });
    fireEvent.click(grip(), { detail: 1 });
    expect(second.onDetentChange.mock.calls).toEqual([["dock"]]);
    second.unmount();
    const third = phone({ detent: "full" });
    fireEvent.click(grip(), { detail: 1 });
    expect(third.onDetentChange.mock.calls).toEqual([["half"]]);
  });

  it("steps with the arrows, jumps with Home and End, toggles with Enter and Space, and closes on Escape", () => {
    const { onDetentChange, onClose } = phone({ detent: "half" });
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End", "Enter", " "]) {
      fireEvent.keyDown(grip(), { key });
    }
    expect(onDetentChange.mock.calls).toEqual([
      ["full"],
      ["dock"],
      ["dock"],
      ["full"],
      ["dock"],
      ["dock"],
    ]);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(grip(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("follows the finger and settles on the nearest detent when it is let go", () => {
    clock();
    const { onDetentChange, onDismiss, sheet } = phone();
    fireEvent.pointerDown(grip(), at(700));
    moveTo(692, 0);
    expect(sheet).toHaveAttribute("data-dragging");
    expect(height(sheet)).toBe("64px");
    moveTo(492, 100);
    expect(height(sheet)).toBe("264px");
    moveTo(356, 200);
    expect(height(sheet)).toBe("400px");
    fireEvent.pointerUp(grip(), at(356));
    expect(sheet).not.toHaveAttribute("data-dragging");
    expect(onDetentChange.mock.calls).toEqual([["half"]]);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("stops at full and settles there after a flick", () => {
    clock();
    const { onDetentChange, sheet } = phone({ detent: "half" });
    fireEvent.pointerDown(grip(), at(500));
    moveTo(492, 0);
    moveTo(450, 100);
    moveTo(-900, 110);
    expect(height(sheet)).toBe("736px");
    fireEvent.pointerUp(grip(), at(-900));
    expect(onDetentChange.mock.calls).toEqual([["full"]]);
  });

  it("dismisses when let go more than 24 px below the dock", () => {
    clock();
    const { onDetentChange, onDismiss, sheet } = phone();
    fireEvent.pointerDown(grip(), at(700));
    moveTo(708, 0);
    moveTo(748, 100);
    expect(height(sheet)).toBe("24px");
    moveTo(768, 200);
    expect(height(sheet)).toBe("4px");
    fireEvent.pointerUp(grip(), at(768));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDetentChange).not.toHaveBeenCalled();
  });

  it("returns to the dock when let go slowly less than 24 px below it", () => {
    clock();
    const { onDetentChange, onDismiss } = phone();
    fireEvent.pointerDown(grip(), at(700));
    moveTo(708, 0);
    moveTo(723, 1000);
    fireEvent.pointerUp(grip(), at(723));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onDetentChange).not.toHaveBeenCalled();
  });

  it("drops a flick when the finger rested before it lifted", () => {
    clock();
    const { onDetentChange } = phone();
    fireEvent.pointerDown(grip(), at(700));
    moveTo(692, 0);
    moveTo(392, 10);
    time.ms = 300;
    fireEvent.pointerUp(grip(), at(392));
    expect(onDetentChange.mock.calls).toEqual([["half"]]);
  });

  it("reads a finger tap that drifts 5 px as a tap, and a mouse press that moves 5 px as a drag", () => {
    const { onDetentChange, sheet } = phone();
    fireEvent.pointerDown(grip(), at(700));
    fireEvent.pointerMove(grip(), at(705));
    expect(sheet).not.toHaveAttribute("data-dragging");
    fireEvent.pointerUp(grip(), at(705));
    fireEvent.click(grip(), { detail: 1 });
    expect(onDetentChange.mock.calls).toEqual([["half"]]);
    const mouse = { pointerId: 3, pointerType: "mouse", clientX: 180 };
    fireEvent.pointerDown(grip(), { ...mouse, clientY: 700 });
    fireEvent.pointerMove(grip(), { ...mouse, clientY: 705 });
    expect(sheet).toHaveAttribute("data-dragging");
  });

  it("does not start a drag under the 3 px slop and reads the tap", () => {
    const { onDetentChange, sheet } = phone();
    fireEvent.pointerDown(grip(), at(700));
    fireEvent.pointerMove(grip(), at(698));
    expect(sheet).not.toHaveAttribute("data-dragging");
    fireEvent.pointerUp(grip(), at(698));
    fireEvent.click(grip(), { detail: 1 });
    expect(onDetentChange.mock.calls).toEqual([["half"]]);
  });

  it("swallows the click a drag leaves behind", () => {
    clock();
    const { onDetentChange } = phone();
    fireEvent.pointerDown(grip(), at(700));
    moveTo(692, 0);
    moveTo(492, 100);
    moveTo(356, 200);
    fireEvent.pointerUp(grip(), at(356));
    fireEvent.click(grip(), { detail: 1 });
    expect(onDetentChange.mock.calls).toEqual([["half"]]);
  });

  it("puts the sheet back on Escape, a blur and a cancel, and reports nothing", () => {
    for (const end of [
      () => fireEvent.keyDown(document.body, { key: "Escape" }),
      () => fireEvent.blur(window),
      () => fireEvent.pointerCancel(grip(), at(500)),
    ]) {
      clock();
      const { onDetentChange, onDismiss, onClose, sheet, unmount } = phone();
      fireEvent.pointerDown(grip(), at(700));
      moveTo(500, 100);
      expect(sheet).toHaveAttribute("data-dragging");
      end();
      expect(sheet).not.toHaveAttribute("data-dragging");
      fireEvent.pointerUp(grip(), at(500));
      expect(
        [onDetentChange, onDismiss, onClose].map((f) => f.mock.calls.length),
      ).toEqual([0, 0, 0]);
      unmount();
    }
  });

  it("ignores a second pointer while one has hold", () => {
    clock();
    const { onDetentChange, sheet } = phone();
    fireEvent.pointerDown(grip(), at(700));
    moveTo(692, 0);
    moveTo(492, 100);
    fireEvent.pointerDown(grip(), at(100, 2));
    moveTo(50, 150, 2);
    expect(height(sheet)).toBe("264px");
    fireEvent.pointerUp(grip(), at(50, 2));
    expect(sheet).toHaveAttribute("data-dragging");
    moveTo(356, 200);
    fireEvent.pointerUp(grip(), at(356));
    expect(onDetentChange.mock.calls).toEqual([["half"]]);
  });

  it("reports nothing when it unmounts mid-drag", () => {
    clock();
    const { onDetentChange, onDismiss, unmount } = phone();
    fireEvent.pointerDown(grip(), at(700));
    moveTo(500, 100);
    unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onDetentChange).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("has no axe violations at the dock and at half", async () => {
    const first = phone();
    await expectNoA11yViolations(first.container);
    first.unmount();
    const second = phone({ detent: "half" });
    await expectNoA11yViolations(second.container);
  });
});
