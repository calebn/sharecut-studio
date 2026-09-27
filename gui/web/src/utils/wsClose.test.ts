import { describe, expect, it } from "vitest";
import { isTerminalWsClose, WS_CLOSE_FORBIDDEN } from "./wsClose";

describe("isTerminalWsClose", () => {
  it("treats 4403 as terminal", () => {
    expect(WS_CLOSE_FORBIDDEN).toBe(4403);
    expect(isTerminalWsClose(4403)).toBe(true);
  });

  it.each([1000, 1006, 1011, 4429])("lets %i reconnect", (code) => {
    expect(isTerminalWsClose(code)).toBe(false);
  });
});
