import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPathInside } from "./pathInside";

export const cleanupManifestEnv = "DAW_E2E_CLEANUP_MANIFEST";

interface CleanupManifest {
  workspaces: string[];
  /** The `npm run test:e2e` process that owns the manifest. */
  pid?: number;
}

export interface E2eCleanupManifest {
  manifestDir: string;
  manifestPath: string;
}

type ManifestRead =
  | { kind: "valid"; value: CleanupManifest }
  | { kind: "missing" | "invalid" };

/**
 * The resolved path of `workspaceDir` when it is a managed E2E workspace
 * (strictly inside `os.tmpdir()` and named `sharecut-e2e-*`); otherwise
 * `undefined`. The single guard for every E2E workspace removal.
 */
export function managedTmpWorkspace(workspaceDir: string): string | undefined {
  const resolved = path.resolve(workspaceDir);
  if (
    !isPathInside(os.tmpdir(), resolved) ||
    !path.basename(resolved).startsWith("sharecut-e2e-")
  ) {
    return undefined;
  }
  return resolved;
}

function readManifest(manifestPath: string): ManifestRead {
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
    if (
      !value ||
      typeof value !== "object" ||
      !Array.isArray((value as CleanupManifest).workspaces) ||
      !(value as CleanupManifest).workspaces.every(
        (workspace) => typeof workspace === "string",
      )
    ) {
      return { kind: "invalid" };
    }
    const { workspaces, pid } = value as CleanupManifest;
    return {
      kind: "valid",
      value: { workspaces, ...(typeof pid === "number" ? { pid } : {}) },
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "invalid" };
  }
}

function requiredManifest(manifestPath: string): CleanupManifest {
  const result = readManifest(manifestPath);
  if (result.kind !== "valid") {
    throw new Error(`E2E cleanup manifest is ${result.kind}: ${manifestPath}`);
  }
  return result.value;
}

export function ownedE2eManifestDirectory(manifestPath: string): string {
  const directory = path.dirname(path.resolve(manifestPath));
  const info = fs.lstatSync(directory);
  const file = fs.lstatSync(manifestPath);
  if (
    !managedTmpWorkspace(directory) ||
    !path.basename(directory).startsWith("sharecut-e2e-cleanup-") ||
    path.basename(manifestPath) !== "workspaces.json" ||
    !info.isDirectory() ||
    !file.isFile() ||
    (process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  ) {
    throw new Error("E2E cleanup manifest must belong to a private invocation");
  }
  requiredManifest(manifestPath);
  return fs.realpathSync(directory);
}

export function registeredE2eCleanupWorkspace(workspaceDir: string): boolean {
  const manifestPath = process.env[cleanupManifestEnv];
  const workspace = managedTmpWorkspace(workspaceDir);
  return Boolean(
    manifestPath &&
      workspace &&
      requiredManifest(manifestPath).workspaces.includes(workspace),
  );
}

function writeManifest(manifestPath: string, manifest: CleanupManifest): void {
  const temporary = `${manifestPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, {
      flag: "wx",
    });
    fs.renameSync(temporary, manifestPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function createE2eCleanupManifest(): E2eCleanupManifest {
  const manifestDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "sharecut-e2e-cleanup-"),
  );
  const manifestPath = path.join(manifestDir, "workspaces.json");
  writeManifest(manifestPath, { workspaces: [], pid: process.pid });
  return { manifestDir, manifestPath };
}

export function registerE2eCleanupWorkspace(
  workspaceDir: string,
  manifestPath = process.env[cleanupManifestEnv],
): boolean {
  const workspace = managedTmpWorkspace(workspaceDir);
  if (!workspace || !manifestPath) {
    return false;
  }
  const manifest = requiredManifest(manifestPath);
  if (!manifest.workspaces.includes(workspace)) {
    manifest.workspaces.push(workspace);
    writeManifest(manifestPath, manifest);
  }
  return true;
}

export function deferE2eWorkspaceCleanup(workspaceDir: string): boolean {
  return registerE2eCleanupWorkspace(workspaceDir);
}

function retryableRemovalError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOTEMPTY" || code === "EBUSY";
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export type WorkspaceRemover = (workspace: string) => void;

export async function cleanupE2eManifest(
  manifest: E2eCleanupManifest,
  removeWorkspace: WorkspaceRemover = (workspace) => {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 0 });
  },
): Promise<void> {
  const manifestRead = requiredManifest(manifest.manifestPath);
  const registered = manifestRead.workspaces;
  const remaining: string[] = [];
  let failure: unknown;
  for (const workspace of new Set(registered)) {
    const safeWorkspace = managedTmpWorkspace(workspace);
    if (!safeWorkspace) {
      continue;
    }
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          removeWorkspace(safeWorkspace);
          break;
        } catch (error) {
          if (!retryableRemovalError(error) || attempt >= 4) {
            throw error;
          }
          await wait(50 * (attempt + 1));
        }
      }
    } catch (error) {
      remaining.push(safeWorkspace);
      failure ??= error;
    }
  }
  if (remaining.length > 0) {
    writeManifest(manifest.manifestPath, {
      ...manifestRead,
      workspaces: remaining,
    });
    throw failure;
  }
  fs.rmSync(manifest.manifestDir, { recursive: true, force: true });
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Finish the cleanup of runs that were killed before their own cleanup ran
 * (SIGKILL, a timed-out job, a closed terminal). Only a manifest this user
 * owns whose recorded run process no longer exists is touched, and only the
 * workspaces that run registered, so a run still in progress is never reaped.
 * Returns the manifest directories it finished.
 */
export async function reapOrphanedE2eManifests(): Promise<string[]> {
  const reaped: string[] = [];
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith("sharecut-e2e-cleanup-")) {
      continue;
    }
    const manifestPath = path.join(os.tmpdir(), name, "workspaces.json");
    try {
      const manifestDir = ownedE2eManifestDirectory(manifestPath);
      const { pid } = requiredManifest(manifestPath);
      if (pid === undefined || !processIsGone(pid)) {
        continue;
      }
      await cleanupE2eManifest({ manifestDir, manifestPath });
      reaped.push(manifestDir);
    } catch {
      // Not ours, not readable, or busy: leave it for its owner.
    }
  }
  return reaped;
}
