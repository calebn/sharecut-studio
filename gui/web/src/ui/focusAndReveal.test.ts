import { afterEach, describe, expect, it } from "vitest";
import { focusAndReveal, revealBelowChrome } from "./focusAndReveal";

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

  it("reveals a field above the sheet's view below its pinned chrome", () => {
    const { sheet, input } = fixture();
    const chrome = document.createElement("div");
    chrome.style.position = "sticky";
    sheet.prepend(chrome);
    chrome.getBoundingClientRect = () => bounds(100, 50);
    sheet.scrollTop = 400;
    focusAndReveal(input);
    // The label (top 360 at scrollTop 0) lands just under the 50 px chrome.
    expect(sheet.scrollTop).toBe(210);
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

describe("revealBelowChrome", () => {
  function pinned(chromeBottom: number, fieldTop: number) {
    const sheet = document.createElement("div");
    const chrome = document.createElement("div");
    const field = document.createElement("input");
    sheet.append(chrome, field);
    document.body.append(sheet);
    Object.defineProperties(sheet, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 1000 },
    });
    sheet.scrollTop = 300;
    chrome.getBoundingClientRect = () => bounds(0, chromeBottom);
    field.getBoundingClientRect = () => bounds(fieldTop, 40);
    return { sheet, chrome, field };
  }

  it("scrolls a field that sits partly under the pinned header to just below it", () => {
    const { sheet, chrome, field } = pinned(100, 93);
    revealBelowChrome(sheet, chrome, field);
    expect(sheet.scrollTop).toBe(293);
  });

  it("reveals the complete fitting label when its field already clears the header", () => {
    const { sheet, chrome, field } = pinned(100, 102);
    const label = document.createElement("label");
    label.getBoundingClientRect = () => bounds(98, 44);
    field.replaceWith(label);
    label.append(field);
    revealBelowChrome(sheet, chrome, field);
    expect(sheet.scrollTop).toBe(298);
  });

  it("leaves a field already clear of the header, and the header's own controls, alone", () => {
    const clear = pinned(100, 100);
    revealBelowChrome(clear.sheet, clear.chrome, clear.field);
    expect(clear.sheet.scrollTop).toBe(300);

    const covered = pinned(100, 20);
    const close = document.createElement("button");
    covered.chrome.append(close);
    revealBelowChrome(covered.sheet, covered.chrome, close);
    expect(covered.sheet.scrollTop).toBe(300);
  });
});
