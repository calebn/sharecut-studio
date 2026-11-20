import { describe, expect, it } from "vitest";
import { isStorybookOnly, selectBrowserStoryShard } from "./storySweepPolicy";

const catalog: readonly { id: string; tags?: readonly string[] }[] = [
  { id: "catalog-only-first", tags: ["storybook-only"] },
  { id: "a" },
  { id: "b", tags: ["wide-only"] },
  { id: "catalog-only-middle", tags: ["storybook-only", "wide-only"] },
  { id: "c", tags: ["almost-storybook-only"] },
  { id: "d", tags: [] },
  { id: "e" },
  { id: "catalog-only-last", tags: ["storybook-only"] },
  { id: "f" },
  { id: "g" },
];

describe("story sweep catalog", () => {
  it("selects only explicitly tagged stories for the Storybook runtime", () => {
    expect(catalog.filter(isStorybookOnly).map((story) => story.id)).toEqual([
      "catalog-only-first",
      "catalog-only-middle",
      "catalog-only-last",
    ]);
  });

  it("assigns only runnable stories before counting positions in each shard", () => {
    const shards = ["1/4", "2/4", "3/4", "4/4"].map((shard) =>
      selectBrowserStoryShard(catalog, shard).map((story) => story.id),
    );

    expect(shards).toEqual([["a", "e"], ["b", "f"], ["c", "g"], ["d"]]);
  });

  it("returns an empty shard when it has no runnable story", () => {
    expect(selectBrowserStoryShard(catalog.slice(0, 2), "2/2")).toEqual([]);
    expect(
      selectBrowserStoryShard(catalog.filter(isStorybookOnly), "1/4"),
    ).toEqual([]);
  });

  it.each([undefined, ""])(
    "runs all browser stories for unset shard %s",
    (shard) => {
      expect(
        selectBrowserStoryShard(catalog, shard).map((story) => story.id),
      ).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    },
  );

  it.each(["0/4", "5/4", "1/0", "one"])("rejects invalid shard %s", (shard) => {
    expect(() => selectBrowserStoryShard(catalog, shard)).toThrow(
      "VITE_STORY_SHARD must be i/n with 1 <= i <= n",
    );
  });
});
