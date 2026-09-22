import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

const EXPECTED_CLIPS = Number(process.env.DAW_BENCHMARK_CLIPS ?? 1_200);
const EXPECTED_WORDS = Number(process.env.DAW_BENCHMARK_WORDS ?? 10_000);

type Profile = {
  domNodes: number;
  heapBytes: number | null;
  label: string;
  milliseconds: number;
};

async function profile<T>(
  page: Page,
  label: string,
  action: () => Promise<T>,
): Promise<Profile> {
  const start = performance.now();
  await action();
  const result = await page.evaluate(() => ({
    domNodes: document.getElementsByTagName("*").length,
    heapBytes:
      "memory" in performance
        ? ((
            performance as Performance & { memory?: { usedJSHeapSize: number } }
          ).memory?.usedJSHeapSize ?? null)
        : null,
  }));
  return { ...result, label, milliseconds: performance.now() - start };
}

test.describe("large project benchmark (opt-in fixture)", () => {
  test.skip(
    !process.env.DAW_BENCHMARK_PROJECT,
    "requires a generated benchmark project",
  );
  test("loads and exercises timeline, transcript, and history surfaces", async ({
    page,
  }) => {
    const profiles: Profile[] = [];
    profiles.push(
      await profile(page, "initial-load", async () => {
        await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
        await expect(page.getByRole("heading", { level: 1 })).toContainText(
          /large-project benchmark/i,
        );
      }),
    );

    const timeline = page.locator(".timeline-scroll");
    await expect(timeline).toBeVisible();
    await expect(page.locator(".clip-block")).toHaveCount(EXPECTED_CLIPS);
    profiles.push(
      await profile(page, "timeline-scroll-seek", async () => {
        await timeline.evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
          element.dispatchEvent(new Event("scroll"));
        });
        await page
          .getByRole("slider", { name: "Timeline position" })
          .press("Home");
        await page
          .getByRole("slider", { name: "Timeline position" })
          .press("End");
      }),
    );

    profiles.push(
      await profile(page, "transcript-open", async () => {
        await page
          .getByRole("button", { name: "Transcript", exact: true })
          .click();
        await expect(page.locator(".transcript-list")).toBeVisible();
        await expect(
          page.locator('.utterance-turn[data-turn-index="0"]'),
        ).toBeVisible();
        await expect(page.locator(".utterance-word").first()).toBeVisible();
      }),
    );
    profiles.push(
      await profile(page, "transcript-scroll-seek", async () => {
        const transcript = page.locator(".transcript-list");
        await transcript.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          element.dispatchEvent(new Event("scroll"));
        });
        await expect(
          page.locator(
            `.utterance-turn[data-turn-index="${EXPECTED_WORDS - 1}"]`,
          ),
        ).toBeVisible();
        await page.locator(".utterance-seek").last().click();
      }),
    );

    profiles.push(
      await profile(page, "history-load", async () => {
        await page
          .getByRole("button", { name: "History", exact: true })
          .click();
        await expect(page.locator(".history-list")).toBeVisible();
        await page.locator(".history-list").evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          element.dispatchEvent(new Event("scroll"));
        });
      }),
    );
    process.stdout.write(
      `large-project benchmark: ${JSON.stringify(profiles)}\n`,
    );
  });
});
