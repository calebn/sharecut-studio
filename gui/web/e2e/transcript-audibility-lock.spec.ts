import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

/** Lock reference:"matters" (word_index 9, t=10s) via a stubbed ProjectView
 * response, the same word `transcript-low-confidence.spec.ts` uses. */
function lockWord(body: Record<string, unknown>): void {
  const transcript = body.transcript as
    | { utterances?: Array<Record<string, unknown>> }
    | null
    | undefined;
  for (const u of transcript?.utterances ?? []) {
    if (u.track_id !== "reference") continue;
    for (const w of (u.words as Array<Record<string, unknown>>) ?? []) {
      if (w.text === "matters") {
        w.audibility_locked = true;
      }
    }
  }
}

test.describe("Audibility lock indicator (#781)", () => {
  test("a locked chip keeps a visible focus ring (WCAG 2.4.7)", async ({
    page,
  }) => {
    await page.route(
      (url) => new URL(url).pathname === "/api/project",
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        lockWord(body);
        await route.fulfill({ response, json: body });
      },
    );

    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await page
      .getByLabel("Editor panels")
      .getByRole("button", { name: "Transcript", exact: true })
      .click();

    const chip = page
      .locator(".transcript-list")
      .getByRole("button", { name: "matters", exact: true })
      .first();
    await expect(chip).toHaveClass(/locked/);
    await expect(chip).toHaveClass(/utterance-word/);

    // Not focused yet: no native focus-visible ring should be drawn.
    const unfocused = await chip.evaluate(
      (el) => window.getComputedStyle(el).outlineStyle,
    );
    expect(unfocused).toBe("none");

    // A keypress first switches Chromium to keyboard input modality, so the
    // programmatic focus() below is treated as keyboard navigation and
    // actually matches `:focus-visible` (a bare .focus() does not).
    await page.keyboard.press("Tab");
    await chip.focus();
    const focused = await chip.evaluate(
      (el) => window.getComputedStyle(el).outlineStyle,
    );
    expect(focused).not.toBe("none");
    expect(focused).not.toBe(unfocused);

    // The lock's own box-shadow (not outline) still marks the chip either way.
    const shadow = await chip.evaluate(
      (el) => window.getComputedStyle(el).boxShadow,
    );
    expect(shadow).not.toBe("none");

    await expectPageAxeClean(page);
  });
});
