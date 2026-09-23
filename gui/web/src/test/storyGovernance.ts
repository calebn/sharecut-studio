import { posix } from "node:path";

/**
 * Story-support modules: import Storybook but are not `*.stories.*`.
 * Only stories and tests may import them. Keep this list short and reviewed.
 */
export const STORY_SUPPORT_MODULES = new Set([
  "record/recordStoryDecorator.tsx",
]);

const IMPORT_SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)["'`]([^"'`\n]+)["'`]/g;
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

/** Module specifiers from static/dynamic imports and re-exports. */
export function importSpecifiers(text: string): string[] {
  return [...text.matchAll(IMPORT_SPECIFIER_RE)].map((m) => m[1]);
}

/** String patterns of each `import.meta.glob(...)` call in `text`. */
export function globPatterns(text: string): string[][] {
  return [...text.matchAll(GLOB_CALL_RE)].map((m) =>
    [...m[1].matchAll(STRING_LITERAL_RE)].map((s) => s[1]),
  );
}

/** True when a glob could pick up a `*.stories.ts(x)` module. */
export function globCanMatchStories(patterns: string[]): boolean {
  if (patterns.some((p) => p.startsWith("!") && p.includes(".stories"))) {
    return false;
  }
  return patterns
    .filter((p) => !p.startsWith("!"))
    .some((p) => {
      if (p.includes(".stories")) {
        return true;
      }
      const base = p.split("/").pop() ?? "";
      return base.includes("*") && /\*$|tsx?/.test(base);
    });
}

/** Ways `rel` (an app file under src/) could pull stories into the bundle. */
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
