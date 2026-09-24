import { describe, expect, it } from "vitest";
import { parseTimecodeSec } from "./timecode";

describe("parseTimecodeSec", () => {
  it("reads transport timecodes and ruler labels", () => {
    expect(parseTimecodeSec("00:15.000")).toBe(15);
    expect(parseTimecodeSec(" 01:00.000 ")).toBe(60);
    expect(parseTimecodeSec("0:45")).toBe(45);
    expect(parseTimecodeSec("1:02:03.5")).toBe(3723.5);
    expect(parseTimecodeSec("12")).toBe(12);
  });
});
