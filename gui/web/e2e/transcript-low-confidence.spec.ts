import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { openPanel, openProject } from "./stageNav";

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
        w.unsure = true;
      }
    }
  }
}

test.describe("Script unsure-word jump (#634)", () => {
  test("the unsure button visits every low-confidence word in order, wraps and selects each", async ({
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

    await openProject(page, e2eProjectPath);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await openPanel(page, "transcript");

    const next = page.getByRole("button", {
      name: "3 unsure words, go to the next",
    });
    await expect(next).toBeVisible();
    const selected = page.locator(
      ".sys-script-body .sys-script-word[data-selected]",
    );
    const stops: [string, string][] = [
      ["reference::3", "delighted"],
      ["reference::24", "delighted"],
      ["guest::12", "antonia"],
      ["reference::3", "delighted"],
    ];

    for (const [key, word] of stops) {
      await next.click();
      await expect(selected).toHaveCount(1);
      await expect(selected).toHaveAttribute("data-word-key", key);
      await expect(selected).toContainText(word);
      await expect(selected).toBeInViewport();
    }

    await expectPageAxeClean(page);
  });
});
