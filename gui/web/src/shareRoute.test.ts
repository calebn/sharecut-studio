import { describe, expect, it } from "vitest";
import { parseShareRoute, recordApiBase, reviewApiBase } from "./shareRoute";

describe("parseShareRoute", () => {
  it("parses review and record paths", () => {
    expect(parseShareRoute("/r/x")).toEqual({ kind: "review", token: "x" });
    expect(parseShareRoute("/rec/x")).toEqual({ kind: "record", token: "x" });
    expect(parseShareRoute("/rec/x/")).toEqual({ kind: "record", token: "x" });
  });

  it("rejects incomplete or extra segments", () => {
    expect(parseShareRoute("/rec/")).toBeNull();
    expect(parseShareRoute("/recx/y")).toBeNull();
    expect(parseShareRoute("/r/x/y")).toBeNull();
  });
});

describe("recordApiBase", () => {
  it("encodes the token", () => {
    expect(recordApiBase("a b")).toBe("/api/rec/a%20b");
  });
});

describe("reviewApiBase", () => {
  it("encodes the token", () => {
    expect(reviewApiBase("a b")).toBe("/api/review/a%20b");
  });
});
