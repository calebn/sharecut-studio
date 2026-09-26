import { describe, expect, it } from "vitest";
import { getByPath, setByPath } from "./configPath";

describe("getByPath", () => {
  it("reads nested values", () => {
    expect(getByPath({ a: { b: 3 } }, "a.b")).toBe(3);
  });

  it("returns undefined for missing and non-object segments", () => {
    expect(getByPath({ a: { b: 3 } }, "a.c")).toBeUndefined();
    expect(getByPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(getByPath({ a: null }, "a.b")).toBeUndefined();
  });
});

describe("setByPath", () => {
  it("creates missing parents", () => {
    expect(setByPath({}, "a.b.c", 1)).toEqual({ a: { b: { c: 1 } } });
  });

  it("does not mutate the input", () => {
    const input = { a: { b: 1, keep: true } };
    const before = structuredClone(input);
    const out = setByPath(input, "a.b", 2);
    expect(input).toEqual(before);
    expect(out).toEqual({ a: { b: 2, keep: true } });
    expect(out.a).not.toBe(input.a);
  });

  it("replaces an array segment with an object", () => {
    expect(setByPath({ a: [1, 2] }, "a.b", 1)).toEqual({ a: { b: 1 } });
  });
});

describe("unsafe paths", () => {
  it("rejects prototype segments", () => {
    expect(() => setByPath({}, "__proto__.polluted", 1)).toThrow(
      /Unsafe config path/,
    );
    expect(() => setByPath({}, "a.constructor.prototype", 1)).toThrow(
      /Unsafe config path/,
    );
    expect(() => getByPath({}, "a.__proto__")).toThrow(/Unsafe config path/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
