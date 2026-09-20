import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deferE2eWorkspaceCleanup,
  registerE2eCleanupWorkspace,
} from "./cleanupManifest";
import { committedE2eProjectPath, repoRoot } from "./env";

const SQLITE = new Set(["sync.db", "sync.db-wal", "sync.db-shm"]);
const SKIP_DIRS = new Set(["history", "_build", ".git"]);

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

/** Copy the committed fixture into a disposable workspace with its own state. */
export function createRelocatedE2eProject(
  prefix = "sharecut-e2e-",
  registerWorkspace: (
    workspaceDir: string,
  ) => boolean = registerE2eCleanupWorkspace,
): RelocatedE2eProject {
  const srcRoot = path.dirname(committedE2eProjectPath);
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let deferred = false;
  try {
    deferred = registerWorkspace(workspaceDir);
    fs.cpSync(srcRoot, workspaceDir, {
      recursive: true,
      filter: (item) =>
        !SQLITE.has(path.basename(item)) && !SKIP_DIRS.has(path.basename(item)),
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
