import { describe, expect, it } from "vitest";
import { withLaunchArgs } from "./launchOptions";

describe("withLaunchArgs", () => {
  it("builds launchOptions from undefined base", () => {
    expect(withLaunchArgs(undefined, ["--a"])).toEqual({ args: ["--a"] });
  });

  it("appends to the base's own args", () => {
    expect(
      withLaunchArgs({ slowMo: 5, args: ["--base"] }, ["--a", "--b"]),
    ).toEqual({ slowMo: 5, args: ["--base", "--a", "--b"] });
  });

  it("does not mutate its inputs", () => {
    const base = { args: ["--base"] };
    const first = withLaunchArgs(base, ["--a"]);
    const second = withLaunchArgs(base, ["--b"]);
    expect(base.args).toEqual(["--base"]);
    expect(first).not.toBe(second);
  });
});
