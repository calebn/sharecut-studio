import { afterEach, describe, expect, it, vi } from "vitest";
import { readLocal, writeLocal } from "./storage";

function securityError(): DOMException {
  return new DOMException("The operation is insecure.", "SecurityError");
}

describe("storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("round-trips values through localStorage", () => {
    expect(readLocal("sharecut.test")).toBeNull();
    writeLocal("sharecut.test", "1");
    expect(readLocal("sharecut.test")).toBe("1");
  });

  it("readLocal returns null when getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw securityError();
    });
    expect(readLocal("sharecut.test")).toBeNull();
  });

  it("writeLocal swallows SecurityError and quota errors from setItem", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw securityError();
      })
      .mockImplementationOnce(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
    expect(() => writeLocal("sharecut.test", "1")).not.toThrow();
    expect(() => writeLocal("sharecut.test", "2")).not.toThrow();
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it("tolerates a throwing localStorage accessor", () => {
    vi.stubGlobal(
      "localStorage",
      new Proxy(
        {},
        {
          get() {
            throw securityError();
          },
        },
      ),
    );
    expect(readLocal("sharecut.test")).toBeNull();
    expect(() => writeLocal("sharecut.test", "1")).not.toThrow();
  });
});
