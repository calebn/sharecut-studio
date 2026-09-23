import { posix } from "node:path";

/**
 * Story-support modules: import Storybook but are not `*.stories.*`.
 * Only stories and tests may import them. Keep this list short and reviewed.
 */
export const STORY_SUPPORT_MODULES = new Set([
  "record/recordStoryDecorator.tsx",
]);

// Literal specifiers only: non-literal `import(x)`, template/concatenated
// strings and path aliases are not detected (see docs/design-system.md).
const IMPORT_SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`\n]+)["'`]/g;
const GLOB_CALL_RE =
  /import\.meta\.glob\s*(?:<[^>]*>)?\s*\(\s*(\[[^\]]*\]|["'`][^"'`\n]*["'`])/g;
const STRING_LITERAL_RE = /["'`]([^"'`\n]*)["'`]/g;
const STORYBOOK_PACKAGE_RE = /^(?:storybook(?:\/|$)|@storybook\/)/;
const STORIES_SPECIFIER_RE = /\.stories(?:\.[cm]?[jt]sx?)?(?:\?.*)?$/;
const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$/;

const SUPPORT_TARGETS = new Set(
  [...STORY_SUPPORT_MODULES].map((rel) => rel.replace(SOURCE_EXT_RE, "")),
);

/** Stories, tests and `test/` helpers may touch stories; app code may not. */
export function isStoryOrTestFile(rel: string): boolean {
  return /\.(?:stories|test)\.[jt]sx?$/.test(rel) || rel.startsWith("test/");
}

/** Module specifiers from static/dynamic imports, re-exports and `require()`. */
export function importSpecifiers(text: string): string[] {
  return [...text.matchAll(IMPORT_SPECIFIER_RE)].map((m) => m[1]);
}

/** String patterns of each `import.meta.glob(...)` call in `text`. */
export function globPatterns(text: string): string[][] {
  return [...text.matchAll(GLOB_CALL_RE)].map((m) =>
    [...m[1].matchAll(STRING_LITERAL_RE)].map((s) => s[1]),
  );
}

/** Extensions Storybook loads stories from (see `.storybook/main.ts`). */
const STORY_EXTS = ["ts", "tsx"];
/** A negation that excludes stories in every directory: `!**` + `/*.stories.<ext>`. */
const GLOBAL_STORY_NEGATION_RE = /^!\*\*\/\*\.stories\.(.+)$/;

/** Extensions named by a negation's `<ext>`: `*`, `tsx`, `{ts,tsx}`, `@(ts|tsx)`. */
function negatedExts(ext: string): string[] {
  if (ext === "*") {
    return STORY_EXTS;
  }
  const alt = /^(?:\{([^{}]*)\}|@\(([^()]*)\))$/.exec(ext);
  return alt ? (alt[1] ?? alt[2]).split(/[,|]/) : [ext];
}

/** Story extensions that a glob's negations exclude in every directory. */
function excludedStoryExts(patterns: string[]): Set<string> {
  const excluded = new Set<string>();
  for (const p of patterns) {
    const ext = GLOBAL_STORY_NEGATION_RE.exec(p)?.[1];
    if (ext !== undefined) {
      for (const e of negatedExts(ext)) {
        excluded.add(e);
      }
    }
  }
  return excluded;
}

/** Story extensions that a positive pattern's file segment can match. */
function matchedStoryExts(base: string): string[] {
  if (!base.includes("*")) {
    return [];
  }
  const named = STORY_EXTS.filter((e) => new RegExp(`\\b${e}\\b`).test(base));
  if (named.length > 0) {
    return named;
  }
  return /\*$|tsx?/.test(base) ? STORY_EXTS : [];
}

/**
 * True when a glob could pick up a `*.stories.ts(x)` module. A negation clears
 * a positive pattern only when it excludes stories of every extension that
 * the pattern can match, in every directory.
 */
export function globCanMatchStories(patterns: string[]): boolean {
  const excluded = excludedStoryExts(patterns);
  return patterns
    .filter((p) => !p.startsWith("!"))
    .some((p) => {
      if (p.includes(".stories")) {
        return true;
      }
      const base = p.split("/").pop() ?? "";
      return matchedStoryExts(base).some((e) => !excluded.has(e));
    });
}

/** Ways `rel` (an app file under src/) could pull stories, Storybook, or test-only modules into the bundle. */
export function storyLeaks(rel: string, text: string): string[] {
  const leaks: string[] = [];
  for (const spec of importSpecifiers(text)) {
    if (STORIES_SPECIFIER_RE.test(spec) || STORYBOOK_PACKAGE_RE.test(spec)) {
      leaks.push(`${rel}: imports ${spec}`);
      continue;
    }
    if (spec.startsWith(".")) {
      const target = posix
        .normalize(posix.join(posix.dirname(rel), spec))
        .replace(SOURCE_EXT_RE, "");
      if (SUPPORT_TARGETS.has(target)) {
        leaks.push(`${rel}: imports story support ${spec}`);
      } else if (target === "test" || isStoryOrTestFile(`${target}.ts`)) {
        leaks.push(`${rel}: imports test-only module ${spec}`);
      }
    }
  }
  for (const patterns of globPatterns(text)) {
    if (globCanMatchStories(patterns)) {
      leaks.push(
        `${rel}: import.meta.glob(${patterns.join(", ")}) can match stories`,
      );
    }
  }
  return leaks;
}

/** True when `text` imports a Storybook package. */
export function importsStorybook(text: string): boolean {
  return importSpecifiers(text).some((s) => STORYBOOK_PACKAGE_RE.test(s));
}
