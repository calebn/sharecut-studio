import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of `gui/web/src`. */
export const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Recursively list `.ts` / `.tsx` files under `dir` (skips `node_modules`,
 * `dist`); `extensions` widens the match. Each real directory is visited once,
 * so symlink cycles terminate.
 */
export function walkTsFiles(
  dir: string,
  out: string[] = [],
  seen: Set<string> = new Set(),
  extensions: RegExp = /\.(ts|tsx)$/,
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
      walkTsFiles(p, out, seen, extensions);
    } else if (extensions.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** `file` relative to `SRC_ROOT` with forward slashes, e.g. `record/GuestRoomApp.tsx`. */
export function srcRelative(file: string): string {
  return relative(SRC_ROOT, file).replace(/\\/g, "/");
}

/** Every `.ts`/`.tsx` file under `dir` (or `extensions` matches), as its `SRC_ROOT`-relative path and contents. */
export function* sourceFiles(
  dir: string = SRC_ROOT,
  extensions?: RegExp,
): Generator<{ rel: string; text: string }> {
  for (const file of walkTsFiles(dir, [], new Set(), extensions)) {
    yield { rel: srcRelative(file), text: readFileSync(file, "utf8") };
  }
}
