import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

/** Lower exactly one word in each selected turn of the repeated speech fixture.
 * The stops are reference index 3 at 2.97s, reference index 24 at 35.97s,
 * and guest index 12 at 43.49s, in transcript order. */
function lower(body: Record<string, unknown>): void {
  const transcript = body.transcript as
    | { utterances?: Array<Record<string, unknown>> }
    | null
    | undefined;
  const targets = new Set(["reference:3", "reference:24", "guest:12"]);
  for (const u of transcript?.utterances ?? []) {
    const trackId = u.track_id as string;
    for (const w of (u.words as Array<Record<string, unknown>>) ?? []) {
      const key = `${trackId}:${String(w.word_index)}`;
      if (targets.has(key)) {
        w.confidence = 0.4;
      }
    }
  }
}

test.describe("Transcript low-confidence walkthrough (#634)", () => {
  test("Next/Previous visit every low-confidence word in order, wrap, and keep the stop marker in Correct mode", async ({
    page,
  }) => {
    await page.route(
      (url) => new URL(url).pathname === "/api/document/state",
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        lower((body.project ?? body.patch) as Record<string, unknown>);
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

    const review = page.getByRole("group", { name: "Low-confidence review" });
    await expect(review).toContainText("3 low-confidence");

    const current = page.locator('.transcript-list [aria-current="true"]');
    const stops: [string, string, number][] = [
      ["reference", "delighted", 3],
      ["reference", "delighted", 24],
      ["guest", "antonia", 12],
      ["reference", "delighted", 3],
    ];

    for (let i = 0; i < stops.length; i++) {
      const [track, word, wordIndex] = stops[i];
      await page
        .getByRole("button", { name: /^Next low-confidence word/ })
        .click();
      await expect(current).toHaveCount(1);
      await expect(current).toHaveText(word);
      await expect(current).toHaveAttribute("data-track-id", track);
      await expect(current).toHaveAttribute(
        "data-word-index",
        String(wordIndex),
      );
      await expect(current).toBeInViewport();
      await expect(review).toContainText(`${(i % 3) + 1}/3`);
    }

    // Previous from "delighted" wraps to the last stop, "antonia".
    await page
      .getByRole("button", { name: /^Previous low-confidence word/ })
      .click();
    await expect(current).toHaveText("antonia");
    await expect(current).toHaveAttribute("data-track-id", "guest");
    await expect(review).toContainText("3/3");

    // Correct mode also selects the stop; the dashed stop marker must still
    // win over .selected's solid accent outline.
    await page.getByRole("button", { name: /^Correct:/i }).click();
    await page
      .getByRole("button", { name: /^Next low-confidence word/ })
      .click();
    await expect(current).toHaveText("delighted");
    await expect(current).toHaveAttribute("data-track-id", "reference");
    await expect(current).toHaveClass(/\bselected\b/);
    await expect(current).toHaveCSS("outline-style", "dashed");
    await expect(review).toContainText("1/3");

    await expectPageAxeClean(page);
  });
});
