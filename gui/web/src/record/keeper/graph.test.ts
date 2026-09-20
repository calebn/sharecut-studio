import { describe, expect, it } from "vitest";
import { KEEPER_PROCESSOR_NAME, KEEPER_PROCESSOR_SOURCE } from "./graph";

describe("keeper worklet source", () => {
  it("registers a processor that copies the input tap", () => {
    expect(KEEPER_PROCESSOR_SOURCE).toContain(
      `registerProcessor("${KEEPER_PROCESSOR_NAME}"`,
    );
    expect(KEEPER_PROCESSOR_SOURCE).toContain("channel.slice()");
    expect(KEEPER_PROCESSOR_SOURCE).not.toContain("destination");
  });
});
