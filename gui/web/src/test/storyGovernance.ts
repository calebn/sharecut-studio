import { posix } from "node:path";
import { parse } from "@babel/parser";

/**
 * Story-support modules: import Storybook but are not `*.stories.*`.
 * Only stories and tests may import them. Keep this list short and reviewed.
 */
export const STORY_SUPPORT_MODULES = new Set([
  "record/recordStoryDecorator.tsx",
  "storybook/docsTheme.ts",
  "storybook/StudioDocsContainer.tsx",
]);

// Literal specifiers only: non-literal `import(x)`, template/concatenated
// strings and path aliases are not detected (see docs/design-system.md).
const STORYBOOK_PACKAGE_RE = /^(?:storybook(?:\/|$)|@storybook\/)/;
const STORIES_SPECIFIER_RE = /\.stories(?:\.[cm]?[jt]sx?)?(?:\?.*)?$/;
const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$/;
/** Root build configs resolve `./src/x` to `../src/x`; map it back to src-relative `x`. */
const FROM_WEB_ROOT_RE = /^\.\.\/src\//;

const SUPPORT_TARGETS = new Set(
  [...STORY_SUPPORT_MODULES].map((rel) => rel.replace(SOURCE_EXT_RE, "")),
);

/** Stories, tests and `test/` helpers may touch stories; app code may not. */
export function isStoryOrTestFile(rel: string): boolean {
  return /\.(?:stories|test)\.[jt]sx?$/.test(rel) || rel.startsWith("test/");
}

/** Module references from real syntax, excluding comments and ordinary strings. */
function sourceReferences(text: string): {
  specifiers: string[];
  globs: string[][];
} {
  const specifiers: string[] = [];
  const globs: string[][] = [];
  const ast = parse(text, {
    sourceType: "unambiguous",
    plugins: ["typescript", "jsx"],
  });
  const isNode = (
    value: unknown,
  ): value is { type: string; [key: string]: unknown } =>
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string";
  const addLiteral = (value: unknown): void => {
    if (
      isNode(value) &&
      value.type === "StringLiteral" &&
      typeof value.value === "string"
    ) {
      specifiers.push(value.value);
    }
  };
  const isGlobCallee = (value: unknown): boolean => {
    if (!isNode(value) || value.type !== "MemberExpression") return false;
    const object = value.object;
    return (
      value.computed === false &&
      isNode(value.property) &&
      value.property.type === "Identifier" &&
      value.property.name === "glob" &&
      isNode(object) &&
      object.type === "MetaProperty" &&
      isNode(object.meta) &&
      object.meta.name === "import" &&
      isNode(object.property) &&
      object.property.name === "meta"
    );
  };
  const addGlob = (value: unknown): void => {
    if (!isNode(value)) return;
    const patterns =
      value.type === "ArrayExpression" ? value.elements : [value];
    if (!Array.isArray(patterns)) return;
    globs.push(
      patterns
        .filter(
          (pattern) => isNode(pattern) && pattern.type === "StringLiteral",
        )
        .map((pattern) => pattern.value as string),
    );
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isNode(value)) return;
    if (
      value.type === "ImportDeclaration" ||
      value.type === "ExportNamedDeclaration" ||
      value.type === "ExportAllDeclaration"
    ) {
      addLiteral(value.source);
    } else if (value.type === "ImportExpression") {
      addLiteral(value.source);
    } else if (value.type === "TSExternalModuleReference") {
      addLiteral(value.expression);
    } else if (value.type === "TSImportType") {
      addLiteral(value.argument);
    } else if (value.type === "CallExpression" && isNode(value.callee)) {
      const firstArgument = Array.isArray(value.arguments)
        ? value.arguments[0]
        : undefined;
      if (
        value.callee.type === "Import" ||
        (value.callee.type === "Identifier" && value.callee.name === "require")
      ) {
        addLiteral(firstArgument);
      } else if (isGlobCallee(value.callee)) {
        addGlob(firstArgument);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(ast);
  return { specifiers, globs };
}

/** Module specifiers from static/dynamic imports, re-exports and `require()`. */
export function importSpecifiers(text: string): string[] {
  return sourceReferences(text).specifiers;
}

/** String patterns of each `import.meta.glob(...)` call in `text`. */
export function globPatterns(text: string): string[][] {
  return sourceReferences(text).globs;
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

/** Glob syntax in an extension segment (`?`, `*`, classes, braces, extglobs). */
const GLOB_SYNTAX_RE = /[?*[\](){}|!+@]/;

/**
 * Story extensions that a positive pattern's file segment can match. A glob
 * in the extension (`ts?(x)`, `[jt]s?(x)`, `{ts,tsx}`, `*`) or no extension
 * at all fails closed as every story extension; a literal extension matches
 * only itself.
 */
function matchedStoryExts(base: string): string[] {
  if (!base.includes("*")) {
    return [];
  }
  const dot = base.lastIndexOf(".");
  const ext = dot === -1 ? "" : base.slice(dot + 1);
  if (dot === -1 || GLOB_SYNTAX_RE.test(ext)) {
    return STORY_EXTS;
  }
  return STORY_EXTS.includes(ext) ? [ext] : [];
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

/**
 * Ways `rel` could pull stories, Storybook, or test-only modules into the
 * bundle. `rel` is src-relative for app files, or `../<name>` for a root
 * build config (gui/web/*.config.*).
 */
export function storyLeaks(rel: string, text: string): string[] {
  const leaks: string[] = [];
  const { specifiers, globs } = sourceReferences(text);
  for (const spec of specifiers) {
    if (STORIES_SPECIFIER_RE.test(spec) || STORYBOOK_PACKAGE_RE.test(spec)) {
      leaks.push(`${rel}: imports ${spec}`);
      continue;
    }
    if (spec.startsWith(".")) {
      const target = posix
        .normalize(posix.join(posix.dirname(rel), spec))
        .replace(FROM_WEB_ROOT_RE, "")
        .replace(SOURCE_EXT_RE, "");
      if (SUPPORT_TARGETS.has(target)) {
        leaks.push(`${rel}: imports story support ${spec}`);
      } else if (target === "test" || isStoryOrTestFile(`${target}.ts`)) {
        leaks.push(`${rel}: imports test-only module ${spec}`);
      }
    }
  }
  for (const patterns of globs) {
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
