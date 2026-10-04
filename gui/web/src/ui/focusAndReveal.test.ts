import { afterEach, describe, expect, it } from "vitest";
import { focusAndReveal } from "./focusAndReveal";

function bounds(top: number, height: number, width = 200): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: width,
    height,
    width,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function fixture() {
  const shell = document.createElement("div");
  shell.style.overflowY = "auto";
  const sheet = document.createElement("div");
  sheet.className = "bottom-sheet";
  sheet.style.overflowY = "auto";
  const label = document.createElement("label");
  const input = document.createElement("input");
  label.append(input);
  sheet.append(label);
  shell.append(sheet);
  document.body.append(shell);
  Object.defineProperties(sheet, {
    clientHeight: { value: 200 },
    clientWidth: { value: 200 },
    scrollHeight: { value: 1000 },
  });
  sheet.getBoundingClientRect = () => bounds(100, 200);
  label.getBoundingClientRect = () => bounds(360 - sheet.scrollTop, 120);
  input.getBoundingClientRect = () => bounds(400 - sheet.scrollTop, 80);
  return { shell, sheet, label, input };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("focusAndReveal", () => {
  it("reveals the whole label and control with minimal local scrolling", () => {
    const { shell, sheet, input } = fixture();
    focusAndReveal(input);
    expect(document.activeElement).toBe(input);
    expect(sheet.scrollTop).toBe(180);
    expect(shell.scrollTop).toBe(0);
    expect(document.documentElement.scrollTop).toBe(0);
    focusAndReveal(input);
    expect(sheet.scrollTop).toBe(180);
    sheet.scrollTop = 400;
    focusAndReveal(input);
    expect(sheet.scrollTop).toBe(260);
  });

  it("reveals fitting field help together with its label and input", () => {
    const { sheet, input } = fixture();
    const error = document.createElement("p");
    error.id = "field-error";
    sheet.append(error);
    input.setAttribute("aria-describedby", error.id);
    error.getBoundingClientRect = () => bounds(480 - sheet.scrollTop, 40);
    focusAndReveal(input);
    expect(sheet.scrollTop).toBe(220);
    expect(input).toHaveFocus();
  });

  it("includes the focus ring without scrolling unrelated ancestors", () => {
    const { sheet, input } = fixture();
    input.style.outlineWidth = "2px";
    input.style.outlineOffset = "2px";
    focusAndReveal(input);
    expect(sheet.scrollTop).toBe(184);
  });

  it("does not touch scrolling outside an inspector or sheet", () => {
    const { sheet, input } = fixture();
    sheet.className = "timeline";
    focusAndReveal(input);
    expect(document.activeElement).toBe(input);
    expect(sheet.scrollTop).toBe(0);
  });

  it("ignores disabled and removed targets", () => {
    const { sheet, input } = fixture();
    input.disabled = true;
    focusAndReveal(input);
    expect(document.activeElement).not.toBe(input);
    expect(sheet.scrollTop).toBe(0);
    input.disabled = false;
    input.remove();
    focusAndReveal(input);
    focusAndReveal(null);
    expect(sheet.scrollTop).toBe(0);
  });
});
