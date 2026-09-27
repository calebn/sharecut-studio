import { describe, expect, it } from "vitest";
import { homeUrl, projectUrl } from "./projectUrl";

describe("projectUrl helpers", () => {
  it("homeUrl drops project, sets home and keeps other params", () => {
    const u = new URL(homeUrl("http://h/?project=a&theme=dark"));
    expect(u.searchParams.has("project")).toBe(false);
    expect(u.searchParams.get("home")).toBe("1");
    expect(u.searchParams.get("theme")).toBe("dark");
  });

  it("projectUrl drops home, sets project and keeps other params", () => {
    const u = new URL(projectUrl("http://h/?home=1&theme=dark", "/p.json"));
    expect(u.searchParams.has("home")).toBe(false);
    expect(u.searchParams.get("project")).toBe("/p.json");
    expect(u.searchParams.get("theme")).toBe("dark");
  });
});
