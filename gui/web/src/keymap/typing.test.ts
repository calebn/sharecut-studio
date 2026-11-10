import { describe, expect, it } from "vitest";
import {
  hasCommandModifier,
  isButtonActivation,
  isChoiceControlArrow,
  isScrubValue,
} from "./typing";

const mods = (
  m: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {},
) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...m,
});

describe("isButtonActivation", () => {
  it.each(["button", "summary"])(
    "reserves bare Space and Enter for focused native %s controls",
    (tag) => {
      const button = document.createElement(tag);
      for (const key of [" ", "Enter"]) {
        const event = new KeyboardEvent("keydown", { key });
        Object.defineProperty(event, "target", { value: button });
        expect(isButtonActivation(event)).toBe(true);
      }
      const modifiedEvent = new KeyboardEvent("keydown", {
        key: " ",
        ctrlKey: true,
      });
      Object.defineProperty(modifiedEvent, "target", { value: button });
      expect(isButtonActivation(modifiedEvent)).toBe(false);

      expect(
        isButtonActivation(new KeyboardEvent("keydown", { key: " " })),
      ).toBe(false);
    },
  );
});

describe("hasCommandModifier", () => {
  it("is false for a bare key", () => {
    expect(hasCommandModifier(mods())).toBe(false);
  });

  it.each(["metaKey", "ctrlKey", "altKey"] as const)(
    "is true when %s is held",
    (key) => {
      expect(hasCommandModifier(mods({ [key]: true }))).toBe(true);
    },
  );

  it("does not treat Shift as a command modifier", () => {
    expect(hasCommandModifier(mods({ shiftKey: true }))).toBe(false);
  });
});

describe("isScrubValue", () => {
  it("matches a spinbutton span and nothing else", () => {
    const span = document.createElement("span");
    span.setAttribute("role", "spinbutton");
    expect(isScrubValue(span)).toBe(true);
    expect(isScrubValue(document.createElement("button"))).toBe(false);
    expect(isScrubValue(null)).toBe(false);
  });
});

describe("isChoiceControlArrow", () => {
  const press = (target: HTMLElement, init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", init);
    Object.defineProperty(event, "target", { value: target });
    return event;
  };
  const segment = () => {
    const group = document.createElement("div");
    group.className = "ui-segmented";
    const button = document.createElement("button");
    group.append(button);
    return button;
  };
  const radio = () => {
    const button = document.createElement("button");
    button.setAttribute("role", "radio");
    return button;
  };

  it("reserves all four bare arrows for a radio", () => {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(isChoiceControlArrow(press(radio(), { key }))).toBe(true);
      expect(
        isChoiceControlArrow(press(radio(), { key, shiftKey: true })),
      ).toBe(true);
    }
  });

  it("reserves Up and Down for a segment and leaves Left and Right to the playhead", () => {
    for (const key of ["ArrowUp", "ArrowDown"]) {
      expect(isChoiceControlArrow(press(segment(), { key }))).toBe(true);
    }
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      expect(isChoiceControlArrow(press(segment(), { key }))).toBe(false);
    }
  });

  it("leaves chords, other keys and other buttons to the keymap", () => {
    for (const make of [segment, radio]) {
      expect(
        isChoiceControlArrow(press(make(), { key: "ArrowUp", metaKey: true })),
      ).toBe(false);
      expect(
        isChoiceControlArrow(press(make(), { key: "ArrowUp", altKey: true })),
      ).toBe(false);
      expect(isChoiceControlArrow(press(make(), { key: "Backspace" }))).toBe(
        false,
      );
    }
    const plain = document.createElement("button");
    expect(isChoiceControlArrow(press(plain, { key: "ArrowUp" }))).toBe(false);
  });
});
