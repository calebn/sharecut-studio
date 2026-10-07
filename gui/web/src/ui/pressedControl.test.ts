import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lastPressedControl,
  lastPressedRect,
  openerControl,
  rememberPressedControl,
} from "./pressedControl";

function rect(top: number, bottom: number): DOMRect {
  return DOMRect.fromRect({ x: 0, y: top, width: 100, height: bottom - top });
}

afterEach(() => {
  document.body.replaceChildren();
  rememberPressedControl(null);
});

describe("pressedControl", () => {
  it("remembers the control behind a click on its icon", () => {
    document.body.innerHTML =
      '<button type="button" id="b"><span id="icon">x</span></button>';
    rememberPressedControl(document.getElementById("icon"));
    expect(lastPressedControl()?.id).toBe("b");
  });

  it("forgets on a click that hits no control", () => {
    document.body.innerHTML =
      '<button type="button" id="b">B</button><div id="canvas"></div>';
    rememberPressedControl(document.getElementById("b"));
    rememberPressedControl(document.getElementById("canvas"));
    expect(lastPressedControl()).toBeNull();
    expect(lastPressedRect()).toBeNull();
  });

  it("keeps where a control was pressed after it re-renders away", () => {
    document.body.innerHTML = '<button type="button" id="b">Move up</button>';
    const button = document.getElementById("b") as HTMLElement;
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(rect(730, 774));
    rememberPressedControl(button);
    button.remove();
    expect(lastPressedControl()).toBeNull();
    expect(lastPressedRect()).toMatchObject({ top: 730, bottom: 774 });
  });

  it("does not count a toast's own Undo or Dismiss", () => {
    document.body.innerHTML =
      '<div class="ui-toast-region"><button type="button" id="undo">Undo</button></div>';
    rememberPressedControl(document.getElementById("undo"));
    expect(lastPressedControl()?.id).toBe("undo");
    expect(lastPressedRect()).toBeNull();
  });

  it("names the clicked control as the opener when focus stayed on <body> or its container", () => {
    document.body.innerHTML =
      '<section id="sheet" tabindex="-1"><button type="button" id="remove">Remove</button></section>';
    rememberPressedControl(document.getElementById("remove"));
    expect(openerControl()?.id).toBe("remove");
    (document.getElementById("sheet") as HTMLElement).focus();
    expect(openerControl()?.id).toBe("remove");
  });

  it("names the focused control as the opener when focus is elsewhere", () => {
    document.body.innerHTML =
      '<button type="button" id="old">Old</button><button type="button" id="focused">Focused</button>';
    rememberPressedControl(document.getElementById("old"));
    (document.getElementById("focused") as HTMLElement).focus();
    expect(openerControl()?.id).toBe("focused");
  });
});
