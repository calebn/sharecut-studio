import { describe, expect, it } from "vitest";
import { hostReconnectDelay } from "./hostReconnect";

describe("host reconnect delay", () => {
  it("spreads failures and caps the actual delay", () => {
    expect(hostReconnectDelay(0, 0)).toBe(250);
    expect(hostReconnectDelay(0, 1)).toBe(500);
    expect(hostReconnectDelay(1, 0)).toBe(500);
    expect(hostReconnectDelay(20, 0)).toBe(15000);
    expect(hostReconnectDelay(20, 1)).toBe(30000);
    expect(hostReconnectDelay(2, 0.5)).toBe(1500);
  });
});
