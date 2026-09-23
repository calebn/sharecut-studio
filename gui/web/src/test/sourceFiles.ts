import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of `gui/web/src`. */
export const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Recursively list `.ts` / `.tsx` files under `dir` (skips `node_modules`,
 * `dist`). Each real directory is visited once, so symlink cycles terminate.
 */
export function walkTsFiles(
  dir: string,
  out: string[] = [],
  seen: Set<string> = new Set(),
): string[] {
  const real = realpathSync(dir);
  if (seen.has(real)) {
    return out;
  }
  seen.add(real);
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") {
      continue;
    }
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walkTsFiles(p, out, seen);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** `file` relative to `SRC_ROOT` with forward slashes, e.g. `record/Declined.tsx`. */
export function srcRelative(file: string): string {
  return relative(SRC_ROOT, file).replace(/\\/g, "/");
}
