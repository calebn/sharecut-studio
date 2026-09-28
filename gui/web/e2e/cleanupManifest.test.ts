import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupE2eManifest,
  createE2eCleanupManifest,
  managedTmpWorkspace,
  registerE2eCleanupWorkspace,
} from "./cleanupManifest";
import { removeAfterTest, tempWorkspace } from "./testWorkspace";

describe("E2E cleanup manifest", () => {
  it("deduplicates registered managed workspaces and removes them after the run", async () => {
    const manifest = createE2eCleanupManifest();
    removeAfterTest(manifest.manifestDir);
    const first = tempWorkspace("sharecut-e2e-test-");
    const second = tempWorkspace("sharecut-e2e-test-");
    expect(registerE2eCleanupWorkspace(first, manifest.manifestPath)).toBe(
      true,
    );
    expect(registerE2eCleanupWorkspace(first, manifest.manifestPath)).toBe(
      true,
    );
    expect(registerE2eCleanupWorkspace(second, manifest.manifestPath)).toBe(
      true,
    );

    const registered = JSON.parse(
      fs.readFileSync(manifest.manifestPath, "utf8"),
    ) as { workspaces: string[] };
    expect(registered.workspaces).toEqual([first, second]);

    await cleanupE2eManifest(manifest);
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(false);
    expect(fs.existsSync(manifest.manifestDir)).toBe(false);
  });

  it("keeps remaining paths when workspace removal fails", async () => {
    const manifest = createE2eCleanupManifest();
    removeAfterTest(manifest.manifestDir);
    const retained = tempWorkspace("sharecut-e2e-test-");
    expect(registerE2eCleanupWorkspace(retained, manifest.manifestPath)).toBe(
      true,
    );

    await expect(
      cleanupE2eManifest(manifest, () => {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }),
    ).rejects.toThrow("permission denied");
    expect(fs.existsSync(manifest.manifestDir)).toBe(true);
    expect(JSON.parse(fs.readFileSync(manifest.manifestPath, "utf8"))).toEqual({
      workspaces: [retained],
    });
  });

  it("surfaces and retains a corrupt manifest", async () => {
    const manifest = createE2eCleanupManifest();
    removeAfterTest(manifest.manifestDir);
    fs.writeFileSync(manifest.manifestPath, "{truncated");

    await expect(cleanupE2eManifest(manifest)).rejects.toThrow(
      "cleanup manifest is invalid",
    );
    expect(fs.existsSync(manifest.manifestDir)).toBe(true);
    expect(fs.readFileSync(manifest.manifestPath, "utf8")).toBe("{truncated");
  });

  it("does not register a path outside the managed tmp prefix", () => {
    const manifest = createE2eCleanupManifest();
    removeAfterTest(manifest.manifestDir);
    expect(
      registerE2eCleanupWorkspace(
        path.join(os.tmpdir(), "outside"),
        manifest.manifestPath,
      ),
    ).toBe(false);
  });
});

describe("managedTmpWorkspace", () => {
  it("returns the resolved path of a sharecut-e2e- dir inside tmp", () => {
    const dir = path.join(os.tmpdir(), "x", "..", "sharecut-e2e-abc");
    expect(managedTmpWorkspace(dir)).toBe(
      path.join(path.resolve(os.tmpdir()), "sharecut-e2e-abc"),
    );
  });

  it("rejects tmp dirs without the sharecut-e2e- prefix", () => {
    expect(managedTmpWorkspace(path.join(os.tmpdir(), "other-abc"))).toBe(
      undefined,
    );
  });

  it("rejects sharecut-e2e- dirs outside tmp", () => {
    const outside = path.join(
      path.dirname(path.resolve(os.tmpdir())),
      "sharecut-e2e-abc",
    );
    expect(managedTmpWorkspace(outside)).toBe(undefined);
    expect(
      managedTmpWorkspace(path.join(os.tmpdir(), "..", "sharecut-e2e-abc")),
    ).toBe(undefined);
  });
});
