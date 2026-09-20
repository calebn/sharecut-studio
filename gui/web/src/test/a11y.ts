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
