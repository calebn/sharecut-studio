import path from "node:path";

/**
 * Whether `candidate` resolves strictly inside `dir`: not `dir` itself, not a
 * `..` escape, not another root. Both are resolved with `path.resolve`;
 * symlinks are not followed.
 */
export function isPathInside(dir: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(candidate));
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}
