import { posix } from "node:path";

/**
 * How a module is pulled in: `import` / `export ... from` / a bare side-effect
 * `import "x"` (`static`), `import type` / `export type ... from` / an import
 * whose specifiers are all `type`-prefixed / `typeof import("x")` (`type`), or
 * an `import("x")` call (`dynamic`).
 */
export type ImportKind = "static" | "type" | "dynamic";

/**
 * One relative import. `from` is the importing file and `to` the target
 * module, both relative to `SRC_ROOT` and without a `.ts` / `.tsx` extension
 * (`state/dawStore`; `api` for both `api.ts` and `api/index.ts`).
 */
export type ImportEdge = { from: string; to: string; kind: ImportKind };

/** Index just past `ch`-quoted string starting at `start` (ends at a newline). */
function endOfString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== quote && text[i] !== "\n") {
    i += text[i] === "\\" ? 2 : 1;
  }
  return Math.min(i + 1, text.length);
}

/**
 * Code from `start`, comments blanked and strings kept. With `inHole` it stops
 * at the `}` closing a template `${` hole and returns that index.
 */
function scanCode(
  text: string,
  start: number,
  inHole: boolean,
): [string, number] {
  let out = "";
  let i = start;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      out += " ";
    } else if (ch === '"' || ch === "'") {
      const end = endOfString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (ch === "`") {
      const [template, next] = scanTemplate(text, i);
      out += template;
      i = next;
    } else if (inHole && ch === "}" && depth === 0) {
      return [out, i];
    } else {
      if (inHole && ch === "{") {
        depth += 1;
      } else if (inHole && ch === "}") {
        depth -= 1;
      }
      out += ch;
      i += 1;
    }
  }
  return [out, i];
}

/** A template literal starting at its opening backtick, `${...}` holes scanned as code. */
function scanTemplate(text: string, start: number): [string, number] {
  let out = "`";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
    } else if (ch === "`") {
      return [`${out}\``, i + 1];
    } else if (ch === "$" && text[i + 1] === "{") {
      const [inner, end] = scanCode(text, i + 2, true);
      out += `\${${inner}`;
      i = end;
    } else {
      out += ch;
      i += 1;
    }
  }
  return [out, i];
}

/**
 * `text` with `//` and `/* *\/` comments removed. String and template contents
 * are kept (a `//` inside a URL string is not a comment). Regex literals are
 * not recognised.
 */
export function stripComments(text: string): string {
  return scanCode(text, 0, false)[0];
}

const SOURCE_EXT = /\.[jt]sx?$/;
const ASSET_EXT = /\.(?:css|svg|png|jpe?g|webp|gif|json|mdx|woff2?|wasm|txt)$/;

/** Path (relative to `SRC_ROOT`, no source extension) a relative `spec` names, or null. */
function resolveSpecifier(fromRel: string, spec: string): string | null {
  if (!spec.startsWith(".")) {
    return null;
  }
  const bare = spec.replace(/\?.*$/, "");
  const joined = posix.normalize(posix.join(posix.dirname(fromRel), bare));
  if (joined.startsWith("..") || ASSET_EXT.test(joined)) {
    return null;
  }
  return joined
    .replace(SOURCE_EXT, "")
    .replace(/\/index$/, "")
    .replace(/\/$/, "");
}

const FROM_CLAUSE =
  /\b(?:import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s*from\s*(["'])([^"']+)\3/g;
const SIDE_EFFECT = /\bimport\s*(["'])([^"']+)\1/g;
const DYNAMIC = /(typeof\s+)?\bimport\s*\(\s*(["'])([^"']+)\2\s*\)/g;

/** A braced clause whose specifiers are all `type X`, which the compiler erases. */
function isAllTypeSpecifiers(clause: string): boolean {
  if (!clause.startsWith("{")) {
    return false;
  }
  const names = clause
    .slice(1, -1)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((n) => /^type\s/.test(n));
}

/**
 * Every relative import in `text`, a file at `rel`: static, `import type`,
 * side-effect, re-export and dynamic `import("...")`. Package and
 * out-of-`src` specifiers, and asset files, are skipped.
 */
export function importEdges(rel: string, text: string): ImportEdge[] {
  const code = stripComments(text);
  const edges: ImportEdge[] = [];
  const add = (spec: string, kind: ImportKind) => {
    const to = resolveSpecifier(rel, spec);
    if (to !== null) {
      edges.push({ from: rel, to, kind });
    }
  };
  for (const m of code.matchAll(FROM_CLAUSE)) {
    add(m[4], m[1] || isAllTypeSpecifiers(m[2]) ? "type" : "static");
  }
  for (const m of code.matchAll(SIDE_EFFECT)) {
    add(m[2], "static");
  }
  for (const m of code.matchAll(DYNAMIC)) {
    add(m[3], m[1] ? "type" : "dynamic");
  }
  return edges;
}

/** Test, story and fixture files, which are free to import across layers. */
export function isTestOrStoryFile(rel: string): boolean {
  return (
    /\.(?:test|stories)\.[jt]sx?$/.test(rel) ||
    rel.startsWith("test/") ||
    rel.startsWith("storybook/")
  );
}
