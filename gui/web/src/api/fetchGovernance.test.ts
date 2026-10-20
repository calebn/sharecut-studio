import { describe, expect, it } from "vitest";
import { sourceFiles } from "../test/sourceFiles";

const HTTP_CLIENT = "api/http.ts";

function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function productionSources(): { rel: string; text: string }[] {
  return [...sourceFiles()]
    .filter(({ rel }) => !/\.(test|spec|stories)\.tsx?$/.test(rel))
    .filter(({ rel }) => !rel.startsWith("test/"))
    .map(({ rel, text }) => ({ rel, text: withoutComments(text) }));
}

function filesMatching(pattern: RegExp): string[] {
  return productionSources()
    .filter(({ text }) => pattern.test(text))
    .map(({ rel }) => rel)
    .sort();
}

describe("one HTTP client", () => {
  it("calls fetch only in api/http.ts", () => {
    expect(filesMatching(/\bfetch\(/)).toEqual([HTTP_CLIENT]);
  });

  it("never passes fetch around as a value", () => {
    expect(
      filesMatching(/\?\s*fetch\s*:|(?:window|globalThis)\.fetch\b/),
    ).toEqual([]);
  });

  it("never discards the error code by throwing a bare response text", () => {
    expect(filesMatching(/throw new Error\(await \w+\.text\(\)\)/)).toEqual([]);
  });

  it("does not read the host session token outside the auth and client modules", () => {
    expect(filesMatching(/X-Podcast-Token/)).toEqual(["sessionAuth.ts"]);
  });
});
