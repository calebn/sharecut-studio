import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Dense DAW chrome trips color-contrast and landmark region heuristics;
 * keep keyboard / name / nesting rules enforced.
 */
export const STUDIO_AXE_DISABLED_RULES = ["color-contrast", "region"] as const;

/** Fail the test when axe reports any violations (pretty-printed). */
export async function expectPageAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .disableRules([...STUDIO_AXE_DISABLED_RULES])
    .analyze();
  expect(
    results.violations,
    JSON.stringify(results.violations, null, 2),
  ).toEqual([]);
}

/**
 * Reading surfaces covered by expectReadingSurfaceAxeClean today:
 * Home (Sharecut Studio) and static marketing HTML. Keep color-contrast and
 * landmark region rules on for those. ReviewApp is not in that suite yet.
 */
export async function expectReadingSurfaceAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations,
    JSON.stringify(results.violations, null, 2),
  ).toEqual([]);
}
