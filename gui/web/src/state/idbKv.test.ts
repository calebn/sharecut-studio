import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idbSet, openDb } from "./idbKv";

let closed = 0;
let putThrows: unknown;
let abortsWith: unknown;
let openThrows: unknown;

function stubIndexedDb() {
  const tx = {
    error: null as unknown,
    oncomplete: () => {},
    onabort: () => {},
    onerror: () => {},
    objectStore() {
      return {
        put() {
          if (putThrows) throw putThrows;
          const request = { error: null as unknown, onerror: () => {} };
          if (abortsWith) {
            // A real quota failure arrives after put returned: the request fails, then the transaction aborts.
            queueMicrotask(() => {
              tx.error = abortsWith;
              request.error = abortsWith;
              request.onerror();
              tx.onabort();
            });
          } else {
            queueMicrotask(() => tx.oncomplete());
          }
          return request;
        },
      };
    },
  };
  vi.stubGlobal("indexedDB", {
    open() {
      if (openThrows) throw openThrows;
      const request = {
        result: {
          close: () => {
            closed++;
          },
          transaction: () => tx,
        },
        onsuccess: () => {},
        onerror: () => {},
        onupgradeneeded: () => {},
      };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  });
}

beforeEach(() => {
  closed = 0;
  putThrows = undefined;
  abortsWith = undefined;
  openThrows = undefined;
  stubIndexedDb();
});
afterEach(() => vi.unstubAllGlobals());

describe("idbSet when the device will not keep the write", () => {
  it("rejects with the error when put throws at once, and lets go of the database", async () => {
    putThrows = new DOMException("full", "QuotaExceededError");
    await expect(idbSet("k", { a: 1 })).rejects.toBe(putThrows);
    expect(closed).toBe(1);
  });

  it("rejects with the error when the transaction aborts for quota later, and lets go of the database", async () => {
    abortsWith = new DOMException("full", "QuotaExceededError");
    await expect(idbSet("k", { a: 1 })).rejects.toBe(abortsWith);
    expect(closed).toBe(1);
  });

  it("writes when nothing is wrong", async () => {
    await expect(idbSet("k", { a: 1 })).resolves.toBeUndefined();
    expect(closed).toBe(1);
  });
});

describe("openDb when the browser blocks the database", () => {
  it("rejects with the error that open threw", async () => {
    openThrows = new DOMException("blocked", "SecurityError");
    await expect(openDb()).rejects.toBe(openThrows);
  });

  it("rejects as blocked when the browser has no database at all", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(openDb()).rejects.toMatchObject({ name: "SecurityError" });
  });
});
