import { afterEach, describe, expect, it } from "vitest";
import { isValidFocusTarget } from "./focusTarget";

describe("effective focus target visibility", () => {
  const nodes: HTMLElement[] = [];
  afterEach(() => {
    for (const node of nodes.splice(0)) node.remove();
  });
  function nestedTarget() {
    const ancestor = document.createElement("div");
    const parent = document.createElement("div");
    const target = document.createElement("button");
    ancestor.append(parent);
    parent.append(target);
    document.body.append(ancestor);
    nodes.push(ancestor);
    return { ancestor, target };
  }

  it("rejects a connected target below a CSS display none ancestor", () => {
    const { ancestor, target } = nestedTarget();
    expect(isValidFocusTarget(target)).toBe(true);
    ancestor.style.display = "none";
    expect(isValidFocusTarget(target)).toBe(false);
  });

  it("preserves a visible child overriding inherited ancestor visibility", () => {
    const { ancestor, target } = nestedTarget();
    ancestor.style.visibility = "hidden";
    expect(isValidFocusTarget(target)).toBe(false);
    target.style.visibility = "visible";
    expect(isValidFocusTarget(target)).toBe(true);
  });
});
