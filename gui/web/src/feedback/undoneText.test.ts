import { describe, expect, it } from "vitest";
import { undoneText } from "./undoneText";

describe("undoneText", () => {
  it.each([
    ["Approved 1 pending edit", "Undone: Approved 1 pending edit"],
    ["3 cuts", "Undone: 3 cuts"],
    ["Removed Host", "Undone: Removed Host"],
    ["Cut to clipboard", "Undone: Cut to clipboard"],
  ])("keeps a short single clause: %s", (message, text) => {
    expect(undoneText(message)).toBe(text);
  });

  it.each([
    "Range cut applied. Use Undo to restore it.",
    "Filled room tone in 3 places. Not everywhere: Undo restores the last one.",
    "Moved the range to Host. Use Undo to restore it.",
    "Text fixed: x",
    "Added Host · 4:12",
    "Approved 3. The cut is held: it needs a listen.",
    "Replaced every mention of the old company name across the whole script",
  ])("is a bare Undone for %s", (message) => {
    expect(undoneText(message)).toBe("Undone.");
  });
});
