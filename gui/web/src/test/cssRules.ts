import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function partial(name: string): string {
  return readFileSync(join(here, "../styles/partials", name), "utf8");
}

/** A selector list, trimmed, whitespace-collapsed and sorted, for comparison. */
export function selectorList(list: string): string {
  return list
    .split(",")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .sort()
    .join(",");
}

const RULE_RE = /(?:^|\n)([^\s{}@][^{}]*?)\{([^}]*)\}/g;

/** Every top-level rule as [selectorList, body] (same regex as `rule`). */
export function rules(css: string): [string, string][] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(RULE_RE)].map((m) => [
    (m[1] ?? "").trim().replace(/\s+/g, " "),
    m[2] ?? "",
  ]);
}

/**
 * The body of the first top-level rule whose selector list equals `selector`,
 * ignoring selector order, spacing and comments.
 */
export function rule(css: string, selector: string): string {
  const want = selectorList(selector);
  for (const [sel, body] of rules(css)) {
    if (body && selectorList(sel) === want) {
      return body;
    }
  }
  throw new Error(`No ${selector} rule`);
}
