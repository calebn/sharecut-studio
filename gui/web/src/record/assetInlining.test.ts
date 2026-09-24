import { describe, expect, it } from "vitest";
import { shouldInlineAsset } from "../../vite.config";

describe("worklet asset URLs", () => {
  it("emits both recording worklets as files for CSP-compatible addModule URLs", () => {
    const tiny = Buffer.from("registerProcessor('meter', class {});");
    expect(shouldInlineAsset("src/record/inputMeterProcessor.js", tiny)).toBe(
      false,
    );
    expect(shouldInlineAsset("src/record/keeperProcessor.js", tiny)).toBe(
      false,
    );
    expect(shouldInlineAsset("src/record/unrelated.js", tiny)).toBe(true);
  });
});
