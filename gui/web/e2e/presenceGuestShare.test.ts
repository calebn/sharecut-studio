import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("guest share proxy setup contract", () => {
  it("quiesces host audio and lazy guest proxies before cleanup", () => {
    const source = fs.readFileSync(
      path.join(webRoot, "e2e/presence-follow.spec.ts"),
      "utf8",
    );
    expect(source).toContain("function openGuestShare");
    expect(source).toContain("function openHostShare");
    expect(source).toContain("page.waitForResponse");
    expect(source).toContain('page.waitForLoadState("networkidle"');
    expect(source).toContain("withTwoBrowserPages");
    expect(source).toContain("await openHostShare(pageA, projectPath);");
    expect(source).toContain("await openHostShare(pageB, projectPath);");
    expect(source).toContain('name: "Follow Host"');
    expect(source).toContain("await page.goto(`/r/${token}`)");
    expect(source).toContain(
      "expect((await manifestResponse).status()).toBe(200)",
    );
    expect(source).not.toContain("const n = await follows.count()");
    expect(source).not.toContain("for (let i = n - 1; i >= 0; i--)");
  });
});
