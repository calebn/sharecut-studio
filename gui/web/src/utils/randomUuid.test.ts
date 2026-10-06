import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUuid } from "./randomUuid";

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUuid", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a v4 UUID where crypto.randomUUID is missing (plain http on the LAN)", () => {
    const real = globalThis.crypto;
    const getRandomValues = (a: Uint8Array<ArrayBuffer>) =>
      real.getRandomValues(a);
    vi.stubGlobal("crypto", {
      getRandomValues,
    });
    const ids = new Set(Array.from({ length: 50 }, () => randomUuid()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(V4);
  });

  it("uses crypto.randomUUID when the context provides it", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
      getRandomValues: () => {
        throw new Error("fallback must not run");
      },
    });
    expect(randomUuid()).toBe("11111111-1111-4111-8111-111111111111");
  });
});
