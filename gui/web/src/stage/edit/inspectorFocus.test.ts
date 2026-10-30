import { afterEach, describe, expect, it } from "vitest";
import { focusFirstControl } from "./inspectorFocus";

function mount(body: string) {
  const box = document.createElement("div");
  box.innerHTML = `<section role="dialog" aria-label="Inspector"><div class="sys-inspector-keys"><div tabindex="-1" data-inspector-anchor></div></div><div class="sys-inspector-scroll">${body}</div></section>`;
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
    expect(document.activeElement).toBe(
      box.querySelector("[data-inspector-anchor]"),
    );
  });

  it.each(["<textarea></textarea>", "<select></select>"])(
    "lands on the dialog for %s first",
    (field) => {
      const box = mount(`${field}<button>Go</button>`);
      focusFirstControl(box);
      expect(document.activeElement).toBe(
        box.querySelector("[data-inspector-anchor]"),
      );
    },
  );

  it("lands on the first control when it is a button", () => {
    const box = mount('<button>Split</button><input type="text">');
    focusFirstControl(box);
    expect(document.activeElement).toBe(box.querySelector("button"));
  });

  it.each(["checkbox", "date", "time"])(
    "lands on the dialog for a %s input, which the keymap also ignores",
    (type) => {
      const box = mount(
        `<input type="${type}" aria-label="Field"><button>Go</button>`,
      );
      focusFirstControl(box);
      expect(document.activeElement).toBe(
        box.querySelector("[data-inspector-anchor]"),
      );
    },
  );

  it("skips a hidden input when it looks for the first control", () => {
    const box = mount('<input type="hidden" name="k"><button>Split</button>');
    focusFirstControl(box);
    expect(document.activeElement).toBe(box.querySelector("button"));
  });
});
