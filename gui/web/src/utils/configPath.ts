/** Dot-path helpers for nested pipeline config objects. */

const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function pathParts(path: string): string[] {
  const parts = path.split(".");
  if (parts.some((part) => UNSAFE_SEGMENTS.has(part))) {
    throw new Error(`Unsafe config path: ${path}`);
  }
  return parts;
}

export function getByPath(
  data: Record<string, unknown>,
  path: string,
): unknown {
  let cur: unknown = data;
  for (const part of pathParts(path)) {
    if (cur == null || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function setByPath(
  data: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const parts = pathParts(path);
  const root = { ...data };
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cur[part];
    const clone =
      next != null && typeof next === "object" && !Array.isArray(next)
        ? { ...(next as Record<string, unknown>) }
        : {};
    cur[part] = clone;
    cur = clone;
  }
  cur[parts[parts.length - 1]!] = value;
  return root;
}
