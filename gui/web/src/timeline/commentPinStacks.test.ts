import { describe, expect, it } from "vitest";
import { sampleComment } from "../test/fixtures";
import { commentPinStacks, nextInStack } from "./commentPinStacks";

const pin = (id: string, start: number) =>
  sampleComment({ id, timeline_start: start, timeline_end: null });

describe("commentPinStacks", () => {
  it("groups pins whose dots overlap and leaves a lone pin out", () => {
    const stacks = commentPinStacks(
      [pin("a", 5), pin("b", 5), pin("c", 5.1), pin("d", 20)],
      10,
    );
    expect(stacks).toEqual([["a", "b", "c"]]);
  });

  it("splits a stack as the zoom opens it", () => {
    const comments = [pin("a", 5), pin("b", 5.5)];
    expect(commentPinStacks(comments, 10)).toEqual([["a", "b"]]);
    expect(commentPinStacks(comments, 40)).toEqual([]);
  });

  it("never stacks a span", () => {
    expect(
      commentPinStacks(
        [
          pin("a", 5),
          sampleComment({ id: "s", timeline_start: 5, timeline_end: 9 }),
        ],
        10,
      ),
    ).toEqual([]);
  });

  it("orders a stack by time whatever the input order", () => {
    expect(commentPinStacks([pin("b", 5.2), pin("a", 5)], 10)).toEqual([
      ["a", "b"],
    ]);
  });
});

describe("nextInStack", () => {
  const stack = ["a", "b", "c"];

  it("opens the clicked pin when none of its stack is selected", () => {
    expect(nextInStack(stack, null, "c")).toBe("c");
    expect(nextInStack(stack, "z", "b")).toBe("b");
  });

  it("steps past the selected member, wrapping, whichever pin took the click", () => {
    expect(nextInStack(stack, "a", "c")).toBe("b");
    expect(nextInStack(stack, "c", "c")).toBe("a");
  });

  it("opens the clicked pin when it stands alone", () => {
    expect(nextInStack(undefined, "a", "b")).toBe("b");
  });
});
