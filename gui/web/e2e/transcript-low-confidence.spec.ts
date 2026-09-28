import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

/**
 * The committed `aligned_dialogue` fixture is all high-confidence (0.95), so
 * the walkthrough has nothing to visit. Stub the ProjectView response and
 * lower three words below 0.7 instead of touching the fixture file. In
 * transcript order (verified against `build_project_view`) these are
 * reference:"matters" (word_index 9, t=10s), reference:"going" (24,
 * t=23.67s) and guest:"learning" (8, t=29.44s).
 */
function lower(body: Record<string, unknown>): void {
  const transcript = body.transcript as
    | { utterances?: Array<Record<string, unknown>> }
    | null
    | undefined;
  const targets = new Set([
    "reference:matters",
    "reference:going",
    "guest:learning",
  ]);
  for (const u of transcript?.utterances ?? []) {
    const trackId = u.track_id as string;
    for (const w of (u.words as Array<Record<string, unknown>>) ?? []) {
      const key = `${trackId}:${(w.text as string)?.toLowerCase()}`;
      if (targets.has(key)) {
        w.confidence = 0.4;
      }
    }
  }
}

test.describe("Transcript low-confidence walkthrough (#634)", () => {
  test("Next/Previous visit every low-confidence word in order and wrap", async ({
    page,
  }) => {
    await page.route(
      (url) => new URL(url).pathname === "/api/project",
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        lower(body);
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
    const stops: [string, string][] = [
      ["reference", "matters"],
      ["reference", "going"],
      ["guest", "learning"],
      ["reference", "matters"],
    ];

    for (let i = 0; i < stops.length; i++) {
      const [track, word] = stops[i];
      await page
        .getByRole("button", { name: /^Next low-confidence word/ })
        .click();
      await expect(current).toHaveCount(1);
      await expect(current).toHaveText(word);
      await expect(current).toHaveAttribute("data-track-id", track);
      await expect(current).toBeInViewport();
      await expect(review).toContainText(`${(i % 3) + 1}/3`);
    }

    // Previous from "matters" wraps to the last stop, "learning".
    await page
      .getByRole("button", { name: /^Previous low-confidence word/ })
      .click();
    await expect(current).toHaveText("learning");
    await expect(current).toHaveAttribute("data-track-id", "guest");
    await expect(review).toContainText("3/3");

    await expectPageAxeClean(page);
  });
});
