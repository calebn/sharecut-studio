import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("guest share proxy setup contract", () => {
  it("shares host and guest setup between both guest scenarios", () => {
    const source = fs.readFileSync(
      path.join(webRoot, "e2e/presence-follow.spec.ts"),
      "utf8",
    );
    const navigationSource = fs.readFileSync(
      path.join(webRoot, "e2e/shareNavigation.ts"),
      "utf8",
    );
    const guestShareMarker = 'test.describe("presence follow guest share"';
    const viewerMarker = 'test("guest follows host on a share token"';
    const editorMarker = 'test("editor guest Mix lock after host FX"';
    const guestShareStart = source.indexOf(guestShareMarker);
    const viewerStart = source.indexOf(viewerMarker, guestShareStart);
    const editorStart = source.indexOf(editorMarker, viewerStart);
    expect(guestShareStart).toBeGreaterThanOrEqual(0);
    expect(viewerStart).toBeGreaterThanOrEqual(0);
    expect(editorStart).toBeGreaterThanOrEqual(0);
    const viewerSource = source.slice(viewerStart, editorStart);
    const editorSource = source.slice(editorStart);
    expect(source).toContain('from "./shareNavigation"');
    expect(navigationSource).toContain("export async function openGuestShare");
    expect(navigationSource).toContain("export async function openHostShare");
    expect(source).toContain("function withHostGuestPages");
    expect(navigationSource).toContain("page.waitForResponse");
    expect(navigationSource).toContain('page.waitForLoadState("networkidle"');
    expect(source).toContain("withTwoBrowserPages");
    expect(source).toContain("await openHostShare(host, projectPath);");
    expect(viewerSource).toContain('withHostGuestPages(browser, "viewer"');
    expect(editorSource).toContain('withHostGuestPages(browser, "editor"');
    expect(viewerSource).toContain('name: "Follow Host"');
    expect(viewerSource).toContain('data-presence-anchor="tab:pipeline"');
    expect(viewerSource).toContain("/auditioning FX/");
    expect(viewerSource).toContain("expectGuestListeningInMix(pageB)");
    expect(editorSource).toContain('test.step("publish host FX presence"');
    expect(editorSource).toContain('test.step("follow host FX presence"');
    expect(editorSource).toContain('test.step("verify guest Mix lock"');
    expect(navigationSource).toContain("page.goto(`/r/${token}`)");
    expect(navigationSource).toContain("expect(response.status()).toBe(200)");
    expect(source).not.toContain("const n = await follows.count()");
    expect(source).not.toContain("for (let i = n - 1; i >= 0; i--)");
  });
});
