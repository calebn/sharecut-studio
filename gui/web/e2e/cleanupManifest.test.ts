import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupE2eManifest,
  createE2eCleanupManifest,
  registerE2eCleanupWorkspace,
} from "./cleanupManifest";

const manifests: string[] = [];
const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  for (const manifest of manifests.splice(0)) {
    fs.rmSync(manifest, { recursive: true, force: true });
  }
});

function workspace(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "sharecut-e2e-test-"));
  workspaces.push(value);
  return value;
}

describe("E2E cleanup manifest", () => {
  it("deduplicates registered managed workspaces and removes them after the run", async () => {
    const manifest = createE2eCleanupManifest();
    manifests.push(manifest.manifestDir);
    const first = workspace();
    const second = workspace();
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
    manifests.push(manifest.manifestDir);
    const retained = workspace();
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
    manifests.push(manifest.manifestDir);
    fs.writeFileSync(manifest.manifestPath, "{truncated");

    await expect(cleanupE2eManifest(manifest)).rejects.toThrow(
      "cleanup manifest is invalid",
    );
    expect(fs.existsSync(manifest.manifestDir)).toBe(true);
    expect(fs.readFileSync(manifest.manifestPath, "utf8")).toBe("{truncated");
  });

  it("does not register a path outside the managed tmp prefix", () => {
    const manifest = createE2eCleanupManifest();
    manifests.push(manifest.manifestDir);
    expect(
      registerE2eCleanupWorkspace(
        path.join(os.tmpdir(), "outside"),
        manifest.manifestPath,
      ),
    ).toBe(false);
  });
});
