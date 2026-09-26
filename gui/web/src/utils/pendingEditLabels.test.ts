import { describe, expect, it } from "vitest";
import { pendingReasonLabel, pendingTypeLabel } from "./pendingEditLabels";

describe("pendingTypeLabel", () => {
  it("names the known types and capitalises the rest", () => {
    expect(pendingTypeLabel("remove")).toBe("Cut");
    expect(pendingTypeLabel("mute")).toBe("Mute");
    expect(pendingTypeLabel("split")).toBe("Split");
    expect(pendingTypeLabel("swap")).toBe("Swap");
  });
});

describe("pendingReasonLabel", () => {
  it.each([
    ["guest:suggest", "Suggested by guest"],
    ["guest:suggest_split", "Split suggested by guest"],
    ["guest:suggest_delete", "Delete suggested by guest"],
    ["guest:suggest_ripple_delete", "Ripple delete suggested by guest"],
    ["nl:range", "Agent edit (time range)"],
    ["nl:manual", "Agent edit"],
    ["nl:words", "Agent edit (selected words)"],
    ["other", "Other"],
    ["nl:match:the end", "Agent edit (matched text)"],
    ["nl:utterance:u7", "Agent edit (utterance)"],
    ["filler:acoustic", "Filler sound"],
    ["filler:um", 'Filler word "um"'],
    ["pause:1.2s", "Long pause (1.2s)"],
    ["repetition:the", "Repeated word"],
    ["restart:we", "False start"],
    ["tangent", "tangent"],
  ])("%s -> %s", (code, label) => {
    expect(pendingReasonLabel(code)).toBe(label);
  });

  it("handles a missing reason", () => {
    expect(pendingReasonLabel(null)).toBe("No reason given");
    expect(pendingReasonLabel(undefined)).toBe("No reason given");
  });
});
