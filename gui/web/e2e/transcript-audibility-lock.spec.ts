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

/** Lock reference:"matters" and also drop its confidence below the low-confidence
 * threshold, so it carries both `.locked` and `.low-confidence`. */
function lockAndLowerWord(body: Record<string, unknown>): void {
  lockWord(body);
  const transcript = body.transcript as
    | { utterances?: Array<Record<string, unknown>> }
    | null
    | undefined;
  for (const u of transcript?.utterances ?? []) {
    if (u.track_id !== "reference") continue;
    for (const w of (u.words as Array<Record<string, unknown>>) ?? []) {
      if (w.text === "matters") {
        w.confidence = 0.4;
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

  test("selecting or tabbing to a locked word shows the explanation in the word inspector (#813)", async ({
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
    await page.getByRole("button", { name: /^Correct:/i }).click();

    const chip = page
      .locator(".transcript-list")
      .getByRole("button", { name: "matters", exact: true })
      .first();
    const inspector = page.locator(".inspector");
    const explanation = inspector.getByText(/Suppression locked: set directly/);

    // Tabbing to the chip and activating it with the keyboard opens the word
    // inspector and shows the explanation as real text, not a hover-only
    // tooltip (#813). A keypress first switches Chromium to keyboard input
    // modality (as in the focus-ring test above), so the focus() below
    // matches `:focus-visible`.
    await page.keyboard.press("Tab");
    await chip.focus();
    await page.keyboard.press("Enter");
    await expect(inspector).toContainText("Suppressed");
    await expect(inspector).toContainText("(locked)");
    await expect(explanation).toBeVisible();
    await expectPageAxeClean(page, ".inspector");

    // Selecting the same word with a mouse click shows the same explanation.
    await chip.click();
    await expect(explanation).toBeVisible();
    await expectPageAxeClean(page, ".inspector");
  });

  test("the lock stays visible on a low-confidence word in Annotate mode", async ({
    page,
  }) => {
    await page.route(
      (url) => new URL(url).pathname === "/api/project",
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        lockAndLowerWord(body);
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

    const annotateBtn = page.getByRole("button", {
      name: /^(Annotate:|Hide annotate)/,
    });
    if ((await annotateBtn.getAttribute("aria-pressed")) !== "true") {
      await annotateBtn.click();
    }

    const chip = page
      .locator(".transcript-list")
      .getByRole("button", { name: "matters", exact: true })
      .first();
    await expect(chip).toHaveClass(/locked/);
    await expect(chip).toHaveClass(/low-confidence/);

    // Both marks must be present: `.low-confidence`'s box-shadow used to come
    // later in the cascade at equal specificity and silently replace `.locked`'s,
    // hiding the lock on exactly the words a reviewer is looking at (#802 review).
    const shadow = await chip.evaluate(
      (el) => window.getComputedStyle(el).boxShadow,
    );
    expect(shadow.match(/inset/g)?.length).toBe(2);

    await expectPageAxeClean(page);
  });
});
