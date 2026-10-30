import { afterEach, describe, expect, it } from "vitest";
import { focusFirstControl } from "./inspectorFocus";

function mount(body: string) {
  const box = document.createElement("div");
  box.innerHTML = `<section role="dialog" aria-label="Inspector" tabindex="-1"><div class="sys-inspector-scroll">${body}</div></section>`;
  document.body.append(box);
  return box;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("focusFirstControl", () => {
  it("lands on the dialog when the first control takes text", () => {
    const box = mount(
      '<input type="text" aria-label="Your name"><button>Go</button>',
    );
    focusFirstControl(box);
    expect(document.activeElement).toBe(box.querySelector('[role="dialog"]'));
  });

  it.each(["<textarea></textarea>", "<select></select>"])(
    "lands on the dialog for %s first",
    (field) => {
      const box = mount(`${field}<button>Go</button>`);
      focusFirstControl(box);
      expect(document.activeElement).toBe(box.querySelector('[role="dialog"]'));
    },
  );

  it("lands on the first control when it is a button", () => {
    const box = mount('<button>Split</button><input type="text">');
    focusFirstControl(box);
    expect(document.activeElement).toBe(box.querySelector("button"));
  });

  it("lands on a checkbox as a control that takes no text", () => {
    const box = mount('<input type="checkbox" aria-label="Mute">');
    focusFirstControl(box);
    expect(document.activeElement).toBe(box.querySelector("input"));
  });
});
