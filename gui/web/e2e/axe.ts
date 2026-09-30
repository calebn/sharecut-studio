import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Dense DAW chrome trips color-contrast and landmark region heuristics;
 * keep keyboard / name / nesting rules enforced.
 */
export const STUDIO_AXE_DISABLED_RULES = ["color-contrast", "region"] as const;

/** Fail the test when axe reports any violations (pretty-printed). */
export async function expectPageAxeClean(
  page: Page,
  selector?: string,
): Promise<void> {
  const builder = new AxeBuilder({ page }).disableRules([
    ...STUDIO_AXE_DISABLED_RULES,
  ]);
  const results = await (selector
    ? builder.include(selector)
    : builder
  ).analyze();
  expect(
    results.violations,
    JSON.stringify(results.violations, null, 2),
  ).toEqual([]);
}

/**
 * Reading surfaces include Home, recording lobbies, guest review, and static
 * marketing HTML. Keep color-contrast and landmark region rules on for those.
 */
export async function expectReadingSurfaceAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations,
    JSON.stringify(results.violations, null, 2),
  ).toEqual([]);
}
