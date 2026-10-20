import { describe, expect, it } from "vitest";
import { sourceFiles } from "../test/sourceFiles";

/** The one module that may write the `selection` key of the DAW store. */
const SELECTION_SLICE = "state/selectionSlice.ts";

const STORE_WRITE = /\b(?:set|setState)\(/g;
const SELECTION_KEY = /[{,]\s*selection\s*[:,}]/;

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function argumentText(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = text.indexOf(ch, i + 1);
      i = end < 0 ? text.length : end;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")" && --depth === 0) {
      return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

function braceText(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

function writesSelectionKey(text: string): boolean {
  const code = withoutComments(text);
  for (const match of code.matchAll(STORE_WRITE)) {
    const open = match.index + match[0].length - 1;
    const argument = argumentText(code, open);
    if (SELECTION_KEY.test(argument)) return true;
    const name = argument.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) {
      const declared = new RegExp(`\\b${name}\\b[^=;(]*=\\s*\\{`).exec(code);
      if (declared) {
        const brace = declared.index + declared[0].length - 1;
        if (SELECTION_KEY.test(braceText(code, brace))) return true;
      }
    }
  }
  return false;
}

const isTestFile = (rel: string) =>
  /\.(test|stories)\.tsx?$/.test(rel) || rel.startsWith("test/");

describe("selection governance", () => {
  it.each([
    ["set({ selection: null })", true],
    ["useDawStore.setState({ selection })", true],
    ["set((s) => ({ selection: next(s), other: 1 }))", true],
    ["set((s) => ({ other: 1, selection: null }))", true],
    ["const patch = { selection: null }; set(patch)", true],
    [
      "const patch: Partial<S> = { a: 1, selection }; useDawStore.setState(patch)",
      true,
    ],
    ["const patch = { other: 1 }; set(patch)", false],
    ["set({ ...selectionPatch(s.selection, next) })", false],
    ["set({ inspectorSelection: next })", false],
    ["set({ selectionHit: null })", false],
    ["// set({ selection: null })", false],
    ["const view = { selection }; render(view)", false],
    ["useDaw((s) => ({ selection: s.selection }))", false],
  ])("flags a write of the selection key in %s: %s", (text, expected) => {
    expect(writesSelectionKey(text)).toBe(expected);
  });

  it("lets no module but the selection slice write selection", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (isTestFile(rel) || rel === SELECTION_SLICE) continue;
      if (writesSelectionKey(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
