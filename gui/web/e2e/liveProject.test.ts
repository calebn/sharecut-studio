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
  copyUxDemoProject,
  createRelocatedE2eProject,
  E2E_FIXTURE_COPY_TEST_TIMEOUT_MS,
  prepareLiveE2eProject,
  removeLiveE2eProject,
  removeRelocatedE2eProject,
  shouldCopyWorkspaceEntry,
} from "./liveProject";

const SKIPPED_SEED_PATHS = [
  "export/x.wav",
  "artifacts/review/abc/mix.wav",
  "artifacts/review/shares.json",
  "artifacts/play_cache/seg.wav",
  "artifacts/session/document.db",
  "history/h.json",
];
const KEPT_SEED_PATHS = [
  "episode.project.json",
  "artifacts/peaks/p.json",
  "transcripts/review/t.json",
  "sources/export/s.wav",
];

function seedSourceRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sharecut-seed-"));
  for (const rel of [...SKIPPED_SEED_PATHS, ...KEPT_SEED_PATHS]) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rel.endsWith(".json") ? "{}" : "");
  }
  return root;
}

describe("createRelocatedE2eProject copy rule", () => {
  it("skips generated and per-machine state but keeps inputs and peaks", () => {
    const sourceRoot = seedSourceRoot();
    let workspaceDir = "";
    try {
      ({ workspaceDir } = createRelocatedE2eProject(
        "sharecut-e2e-seed-",
        () => false,
        sourceRoot,
      ));
      for (const rel of SKIPPED_SEED_PATHS) {
        expect(fs.existsSync(path.join(workspaceDir, rel)), rel).toBe(false);
      }
      for (const rel of KEPT_SEED_PATHS) {
        expect(fs.existsSync(path.join(workspaceDir, rel)), rel).toBe(true);
      }
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      if (workspaceDir) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    }
  });

  it("excludes every entry the fixture .gitignore ignores", () => {
    const gitignore = fs.readFileSync(
      path.join(path.dirname(committedE2eProjectPath), ".gitignore"),
      "utf8",
    );
    const patterns = gitignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      const negated = pattern.startsWith("!");
      const probe = (negated ? pattern.slice(1) : pattern)
        .replace(/\*/g, "__probe__")
        .replace(/\/$/, "");
      expect(shouldCopyWorkspaceEntry(probe), pattern).toBe(negated);
      if (!negated) {
        expect(shouldCopyWorkspaceEntry(`${probe}/child.json`), pattern).toBe(
          false,
        );
      }
    }
    expect(shouldCopyWorkspaceEntry("artifacts")).toBe(true);
    expect(shouldCopyWorkspaceEntry("artifacts/peaks")).toBe(true);
    expect(shouldCopyWorkspaceEntry("artifacts/peaks/guest.json")).toBe(true);
  });
});

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

describe("copyUxDemoProject", () => {
  const saved = process.env.UX_DEMO_PROJECT;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.UX_DEMO_PROJECT;
    } else {
      process.env.UX_DEMO_PROJECT = saved;
    }
  });

  it("copies media behind symlinks and reuses the copy", () => {
    delete process.env.UX_DEMO_PROJECT;
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "ux-demo-src-"));
    const media = path.join(src, "real.wav");
    fs.writeFileSync(media, "RIFF");
    fs.mkdirSync(path.join(src, "demo", "raw"), { recursive: true });
    fs.writeFileSync(path.join(src, "demo", "episode.project.json"), "{}");
    fs.symlinkSync(media, path.join(src, "demo", "raw", "a.wav"));
    const projectPath = copyUxDemoProject(
      path.join(src, "demo", "episode.project.json"),
    );
    try {
      const copied = path.join(path.dirname(projectPath), "raw", "a.wav");
      expect(fs.lstatSync(copied).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(copied, "utf8")).toBe("RIFF");
      expect(copyUxDemoProject("/nowhere/episode.project.json")).toBe(
        projectPath,
      );
    } finally {
      fs.rmSync(path.dirname(projectPath), { recursive: true, force: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
  });
});
