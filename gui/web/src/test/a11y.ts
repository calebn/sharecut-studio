import axe from "axe-core";
import { expect } from "vitest";

/** Assert a rendered container has no axe accessibility violations. */
export async function expectNoA11yViolations(
  container: HTMLElement,
): Promise<void> {
  const results = await axe.run(container);
  expect(
    results.violations,
    results.violations
      .map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`)
      .join("\n") || undefined,
  ).toEqual([]);
}

const LIVE_REGION =
  '[aria-live], [role="status"], [role="alert"], [role="log"]';

/**
 * Assert every element whose own text matches `text` sits outside every live
 * region, so a change to it is never spoken. Fails when nothing matches, so
 * the check cannot pass on an empty render.
 */
export function expectOutsideLiveRegions(
  container: HTMLElement,
  text: RegExp,
): void {
  const matches = [...container.querySelectorAll("*")].filter((el) =>
    [...el.childNodes].some(
      (node) =>
        node.nodeType === Node.TEXT_NODE && text.test(node.textContent ?? ""),
    ),
  );
  expect(matches.length, `no element matches ${text}`).toBeGreaterThan(0);
  for (const el of matches) {
    expect(
      el.closest(LIVE_REGION)?.outerHTML.slice(0, 120) ?? null,
      `"${el.textContent}" sits in a live region`,
    ).toBeNull();
  }
}
