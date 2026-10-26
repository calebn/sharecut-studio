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

/** Axe over one surface with color-contrast on; only the page-landmark rule stays off. */
export async function expectSurfaceAxeClean(
  page: Page,
  selector: string,
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .disableRules(["region"])
    .include(selector)
    .analyze();
  expect(
    results.violations,
    JSON.stringify(results.violations, null, 2),
  ).toEqual([]);
}

/**
 * Storybook stories render one component, not a page. This runs the WCAG 2.0
 * A and AA rules the Storybook addon runs, color-contrast included, and leaves the page-level
 * best practices (one main landmark, one h1) to the page specs.
 */
export const STORY_AXE_TAGS = ["wcag2a", "wcag2aa"] as const;

export async function expectStoryAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags([...STORY_AXE_TAGS])
    .analyze();
  expect(
    results.violations,
    JSON.stringify(results.violations, null, 2),
  ).toEqual([]);
}
