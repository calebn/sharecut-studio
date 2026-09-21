import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupE2eManifest,
  createE2eCleanupManifest,
} from "./cleanupManifest";
import { committedE2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  E2E_FIXTURE_COPY_TEST_TIMEOUT_MS,
  prepareLiveE2eProject,
  removeLiveE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";

describe("prepareLiveE2eProject", () => {
  afterEach(() => {
    removeLiveE2eProject();
    delete process.env.DAW_E2E_PROJECT;
    delete process.env.DAW_E2E_WORKSPACE;
    delete process.env.DAW_E2E_CLEANUP_MANIFEST;
  });

  it("removes a new workspace when manifest registration fails", () => {
    let workspaceDir = "";
    expect(() =>
      createRelocatedE2eProject("sharecut-e2e-register-", (workspace) => {
        workspaceDir = workspace;
        throw new Error("manifest unavailable");
      }),
    ).toThrow("manifest unavailable");
    expect(fs.existsSync(workspaceDir)).toBe(false);
  });

  it(
    "defers registered fixture removal until the runner owns cleanup",
    async () => {
      const manifest = createE2eCleanupManifest();
      process.env.DAW_E2E_CLEANUP_MANIFEST = manifest.manifestPath;
      const { workspaceDir } = createRelocatedE2eProject();

      removeRelocatedE2eProject(workspaceDir);
      expect(fs.existsSync(workspaceDir)).toBe(true);

      await cleanupE2eManifest(manifest);
      expect(fs.existsSync(workspaceDir)).toBe(false);
      delete process.env.DAW_E2E_CLEANUP_MANIFEST;
    },
    E2E_FIXTURE_COPY_TEST_TIMEOUT_MS,
  );

  it(
    "copies into tmp and does not write the committed tree",
    () => {
      delete process.env.DAW_E2E_PROJECT;
      delete process.env.DAW_E2E_WORKSPACE;
      const projectPath = prepareLiveE2eProject();
      const dest = path.dirname(projectPath);
      expect(projectPath).not.toBe(committedE2eProjectPath);
      expect(dest.startsWith(os.tmpdir())).toBe(true);
      const data = JSON.parse(fs.readFileSync(projectPath, "utf8")) as {
        meta?: { workspace_dir?: string };
      };
      expect(data.meta?.workspace_dir).toBe(dest);
      expect(
        fs.existsSync(path.join(dest, "artifacts", "session", "sync.db")),
      ).toBe(false);
      const probe = path.join(dest, "transcripts", "_probe.json");
      fs.mkdirSync(path.dirname(probe), { recursive: true });
      fs.writeFileSync(probe, "{}");
      expect(
        fs.existsSync(
          path.join(
            path.dirname(committedE2eProjectPath),
            "transcripts",
            "_probe.json",
          ),
        ),
      ).toBe(false);
      removeLiveE2eProject();
      expect(fs.existsSync(dest)).toBe(false);
    },
    E2E_FIXTURE_COPY_TEST_TIMEOUT_MS,
  );
});
