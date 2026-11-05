import { describe, expect, it } from "vitest";
import { homeUrl, projectNameFromPath, projectUrl } from "./projectUrl";

describe("projectUrl helpers", () => {
  it("homeUrl drops project, sets home and keeps other params", () => {
    const u = new URL(homeUrl("http://h/?project=a&theme=dark"));
    expect(u.searchParams.has("project")).toBe(false);
    expect(u.searchParams.get("home")).toBe("1");
    expect(u.searchParams.get("theme")).toBe("dark");
  });

  it("homeUrl can ask Home for the path field, and drops a stale ask", () => {
    const asked = new URL(homeUrl("http://h/?project=a", { openOther: true }));
    expect(asked.searchParams.get("openOther")).toBe("1");
    expect(
      new URL(homeUrl(asked.toString())).searchParams.has("openOther"),
    ).toBe(false);
  });

  it("projectUrl drops home, sets project and keeps other params", () => {
    const u = new URL(projectUrl("http://h/?home=1&theme=dark", "/p.json"));
    expect(u.searchParams.has("home")).toBe(false);
    expect(u.searchParams.get("project")).toBe("/p.json");
    expect(u.searchParams.get("theme")).toBe("dark");
  });

  it("projectNameFromPath names the folder of a project file, or the folder itself", () => {
    expect(
      projectNameFromPath("/home/u/ShareCut/Rosa and Maya/episode.sharecut"),
    ).toBe("Rosa and Maya");
    expect(projectNameFromPath("/home/u/ShareCut/Ep. 3")).toBe("Ep. 3");
    expect(projectNameFromPath("/home/u/ShareCut/Rosa.v2")).toBe("Rosa.v2");
    expect(projectNameFromPath("C:\\Shows\\Pilot\\episode.sharecut")).toBe(
      "Pilot",
    );
    expect(projectNameFromPath("")).toBe("");
  });
});
