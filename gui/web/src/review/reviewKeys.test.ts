import { describe, expect, it } from "vitest";
import { stageActionFor } from "./reviewKeys";

type Input = Parameters<typeof stageActionFor>[0];

const key = (k: string, over: Partial<Input> = {}): Input => ({
  key: k,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  repeat: false,
  ...over,
});

describe("stageActionFor", () => {
  it("maps the verb table keys", () => {
    expect(stageActionFor(key("Enter"))).toBe("verb");
    expect(stageActionFor(key("x"))).toBe("keep");
    expect(stageActionFor(key("ArrowDown"))).toBe("next");
    expect(stageActionFor(key("ArrowUp"))).toBe("previous");
    expect(stageActionFor(key("a"))).toBe("hearBefore");
    expect(stageActionFor(key("b"))).toBe("hearAfter");
    expect(stageActionFor(key("Enter", { shiftKey: true }))).toBe("applyAll");
  });

  it("ignores editable targets", () => {
    const input = document.createElement("input");
    expect(stageActionFor(key("x", { target: input }))).toBeNull();
  });

  it("ignores held keys that decide", () => {
    expect(stageActionFor(key("Enter", { repeat: true }))).toBeNull();
    expect(
      stageActionFor(key("Enter", { shiftKey: true, repeat: true })),
    ).toBeNull();
    expect(stageActionFor(key("x", { repeat: true }))).toBeNull();
    expect(stageActionFor(key("c", { repeat: true }))).toBeNull();
    expect(stageActionFor(key("e", { repeat: true }))).toBeNull();
    expect(stageActionFor(key("ArrowDown", { repeat: true }))).toBe("next");
  });

  describe("Tab", () => {
    const root = document.createElement("div");
    const text = document.createElement("p");
    const button = document.createElement("button");
    const toast = document.createElement("div");
    const undo = document.createElement("button");
    toast.append(undo);
    root.append(text, button, toast);

    it("passes through on the root, so focus can leave", () => {
      expect(stageActionFor(key("Tab", { target: root }), { root })).toBeNull();
      expect(
        stageActionFor(key("Tab", { shiftKey: true, target: root }), { root }),
      ).toBeNull();
    });

    it("passes through on a button and on the Undo toast button", () => {
      expect(
        stageActionFor(key("Tab", { target: button }), { root }),
      ).toBeNull();
      expect(stageActionFor(key("Tab", { target: undo }), { root })).toBeNull();
    });

    it("steps on a plain element inside the stage", () => {
      expect(stageActionFor(key("Tab", { target: text }), { root })).toBe(
        "next",
      );
      expect(
        stageActionFor(key("Tab", { shiftKey: true, target: text }), { root }),
      ).toBe("previous");
    });
  });

  it("leaves Enter on a control to the control", () => {
    const button = document.createElement("button");
    expect(stageActionFor(key("Enter", { target: button }))).toBeNull();
    expect(stageActionFor(key("x", { target: button }))).toBe("keep");
  });

  it("uses Backspace as the verb only for a cut", () => {
    expect(stageActionFor(key("Backspace"), { primary: "cut" })).toBe("verb");
    expect(stageActionFor(key("Backspace"), { primary: "lower" })).toBeNull();
  });

  it("leaves Backspace to a focused waveform handle", () => {
    const handle = document.createElement("span");
    handle.setAttribute("role", "slider");
    expect(
      stageActionFor(key("Backspace", { target: handle }), { primary: "cut" }),
    ).toBeNull();
  });

  it("ignores chords with Ctrl or Meta", () => {
    expect(stageActionFor(key("x", { metaKey: true }))).toBeNull();
  });
});
