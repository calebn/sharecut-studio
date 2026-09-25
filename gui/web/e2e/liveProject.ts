import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deferE2eWorkspaceCleanup,
  registerE2eCleanupWorkspace,
} from "./cleanupManifest";
import { committedE2eProjectPath, repoRoot } from "./env";

// Workspace copy rule: skip generated output and per-machine review/share
// state, keeping only committed inputs plus artifacts/peaks/. Source of truth is
// tests/fixtures/aligned_dialogue/.gitignore (parity enforced in
// liveProject.test.ts); Python's WORKSPACE_COPY_IGNORE in
// src/podcast_mcp/project_io.py is stricter and skips all of artifacts/.
const SQLITE_FILES = new Set(["sync.db", "sync.db-wal", "sync.db-shm"]);
const SKIP_ANY_DEPTH = new Set([".git"]);
const SKIP_TOP_LEVEL = new Set(["history", "export", "_build"]);
const ARTIFACTS_ALLOW = new Set(["peaks"]);

/** Whether a path relative to the fixture workspace root belongs in the copy. */
export function shouldCopyWorkspaceEntry(relativePath: string): boolean {
  if (relativePath === "") {
    return true;
  }
  const parts = relativePath.split(/[\\/]/);
  const name = parts[parts.length - 1];
  if (SQLITE_FILES.has(name) || SKIP_ANY_DEPTH.has(name)) {
    return false;
  }
  const [top, child] = parts;
  if (SKIP_TOP_LEVEL.has(top)) {
    return false;
  }
  if (top === "artifacts" && child !== undefined) {
    return ARTIFACTS_ALLOW.has(child);
  }
  return true;
}

/** Vitest timeout for tests that copy the committed large fixture. */
export const E2E_FIXTURE_COPY_TEST_TIMEOUT_MS = 20_000;

export const e2eWorkspaceStampPath = path.join(
  repoRoot,
  "gui/web/test-results/e2e-workspace.txt",
);

export function relocateWorkspaceDir(
  projectPath: string,
  workspaceDir: string,
): void {
  const data = JSON.parse(fs.readFileSync(projectPath, "utf8")) as {
    meta?: { workspace_dir?: string };
  };
  data.meta = { ...(data.meta || {}), workspace_dir: workspaceDir };
  fs.writeFileSync(projectPath, `${JSON.stringify(data, null, 2)}\n`);
}

export interface RelocatedE2eProject {
  projectPath: string;
  workspaceDir: string;
}

/**
 * Copy the committed fixture into a disposable workspace with its own state.
 *
 * The copy drops all generated artifacts/ state except peaks/. A locally
 * modified fixture whose review.versions or render.artifacts entries point at
 * artifacts/ audio will not resolve that audio in the copy; restore the clean
 * committed state with
 * `git checkout -- tests/fixtures/aligned_dialogue/episode.project.json`.
 */
export function createRelocatedE2eProject(
  prefix = "sharecut-e2e-",
  registerWorkspace: (
    workspaceDir: string,
  ) => boolean = registerE2eCleanupWorkspace,
  sourceRoot = path.dirname(committedE2eProjectPath),
): RelocatedE2eProject {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let deferred = false;
  try {
    deferred = registerWorkspace(workspaceDir);
    fs.cpSync(sourceRoot, workspaceDir, {
      recursive: true,
      filter: (item) =>
        shouldCopyWorkspaceEntry(path.relative(sourceRoot, item)),
    });
    const projectPath = path.join(workspaceDir, "episode.project.json");
    relocateWorkspaceDir(projectPath, workspaceDir);
    return { projectPath, workspaceDir };
  } catch (error) {
    if (!deferred) fs.rmSync(workspaceDir, { recursive: true, force: true });
    throw error;
  }
}

export function removeRelocatedE2eProject(workspaceDir: string): void {
  if (deferE2eWorkspaceCleanup(workspaceDir)) {
    return;
  }
  const resolved = path.resolve(workspaceDir);
  const tmp = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (
    !resolved.startsWith(tmp) ||
    !path.basename(resolved).startsWith("sharecut-e2e-")
  ) {
    return;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

export function prepareLiveE2eProject(): string {
  const existing = process.env.DAW_E2E_PROJECT;
  if (existing && fs.existsSync(existing)) {
    return existing;
  }
  const { projectPath, workspaceDir } = createRelocatedE2eProject();
  process.env.DAW_E2E_PROJECT = projectPath;
  process.env.DAW_E2E_WORKSPACE = workspaceDir;
  fs.mkdirSync(path.dirname(e2eWorkspaceStampPath), { recursive: true });
  fs.writeFileSync(e2eWorkspaceStampPath, `${workspaceDir}\n`);
  return projectPath;
}

export function removeLiveE2eProject(): void {
  let dest = process.env.DAW_E2E_WORKSPACE;
  if (!dest && fs.existsSync(e2eWorkspaceStampPath)) {
    dest = fs.readFileSync(e2eWorkspaceStampPath, "utf8").trim();
  }
  if (!dest) {
    return;
  }
  removeRelocatedE2eProject(dest);
  if (fs.existsSync(e2eWorkspaceStampPath)) {
    fs.unlinkSync(e2eWorkspaceStampPath);
  }
}

/**
 * Copy a directory tree, replacing every symlink by what it points at.
 * (`fs.cpSync`'s `dereference` only follows a symlinked source root.)
 */
function copyDereferenced(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) {
      copyDereferenced(from, to);
    } else {
      fs.copyFileSync(fs.realpathSync(from), to);
    }
  }
}

/**
 * The UX demo fixture with its media copied in. Its `raw/` files are
 * symlinks out of the fixture, which the waveform routes reject
 * (`resolve_within`), so screenshots pin a dereferenced copy. The copy is
 * reused by every Playwright process of the run (`UX_DEMO_PROJECT`).
 */
export function copyUxDemoProject(demoProjectPath: string): string {
  const existing = process.env.UX_DEMO_PROJECT;
  if (existing && fs.existsSync(existing)) {
    return existing;
  }
  const workspaceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "sharecut-e2e-ux-demo-"),
  );
  copyDereferenced(path.dirname(demoProjectPath), workspaceDir);
  const projectPath = path.join(workspaceDir, path.basename(demoProjectPath));
  process.env.UX_DEMO_PROJECT = projectPath;
  return projectPath;
}
