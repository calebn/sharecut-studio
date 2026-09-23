import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configuredE2ePort } from "./port";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const repoRoot = path.resolve(webRoot, "../..");

export const committedE2eProjectPath = path.join(
  repoRoot,
  "tests/fixtures/aligned_dialogue/episode.project.json",
);

export const e2eProjectPath =
  process.env.DAW_E2E_PROJECT || committedE2eProjectPath;

// realpathSync.native follows symlinks and, on case-insensitive volumes
// (default macOS APFS), returns the on-disk spelling. Paths that do not
// exist yet fall back to path.resolve.
function canonicalE2ePath(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Throw if `projectPath` is the committed `aligned_dialogue` fixture.
 *
 * `e2eProjectPath` falls back to the committed fixture when `DAW_E2E_PROJECT`
 * is unset (UX screenshot runs, Vitest, callers outside Playwright). Callers
 * that switch the loopback GUI must pass a disposable copy instead.
 */
export function assertDisposableE2eProject(projectPath: string): void {
  if (
    canonicalE2ePath(projectPath) === canonicalE2ePath(committedE2eProjectPath)
  ) {
    throw new Error(
      `Refusing to switch the E2E GUI to the committed fixture ${committedE2eProjectPath}; ` +
        "set DAW_E2E_PROJECT to a disposable copy (playwright.config.ts does this via prepareLiveE2eProject()).",
    );
  }
}

export const e2eHost = "127.0.0.1";
// The wrapper owns allocation. Config imports only consume its published value.
export const e2ePort = configuredE2ePort() ?? 8766;

export function e2eUrl(port = e2ePort): string {
  return `http://${e2eHost}:${port}`;
}

export const e2eBaseURL = e2eUrl();
