import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { repoRoot } from "./env";
import { openPanel, openProject } from "./stageNav";
import { setTheme, type Theme } from "./theme";

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

async function recordPlacement(page: Page, name: string) {
  await expect(
    page.getByRole("group", { name: "Selection actions" }),
  ).toBeVisible();
  const measured = await page.evaluate(() => {
    const word = document.querySelector<HTMLElement>(
      ".sys-script-body .sys-script-word[data-selected]",
    );
    const header = word
      ?.closest(".sys-script")
      ?.querySelector(".sys-script-header");
    const content = word?.closest(".edit-workspace");
    const bar = document.querySelector(
      '[role="group"][aria-label="Selection actions"]',
    );
    const next = document.querySelector(".sys-script-unsure");
    if (!word || !header || !bar || !next || !content)
      throw new Error("Words placement subjects are missing");
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const wordRect = rect(word);
    const nextLine = [
      ...document.querySelectorAll<HTMLElement>(
        ".sys-script-body .sys-script-word",
      ),
    ].find((el) => el.getBoundingClientRect().top >= wordRect.bottom);
    const nextRect = rect(next);
    const hit = document.elementFromPoint(
      (nextRect.left + nextRect.right) / 2,
      (nextRect.top + nextRect.bottom) / 2,
    );
    return {
      viewport: { width: innerWidth, height: innerHeight },
      word: { ...wordRect, key: word.dataset.wordKey },
      header: rect(header),
      content: rect(content),
      bar: rect(bar),
      next: { ...nextRect, reachable: hit === next || next.contains(hit) },
      nextLine: nextLine
        ? { ...rect(nextLine), key: nextLine.dataset.wordKey }
        : null,
    };
  });
  const overlap = (a: typeof measured.bar, b: typeof measured.bar) =>
    Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
    Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
  const directory = path.join(
    repoRoot,
    "gui/web/playwright-report/words-actionbar",
  );
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${name}.json`),
    `${JSON.stringify(measured, null, 2)}\n`,
  );
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
  expect(overlap(measured.bar, measured.header)).toBe(false);
  expect(overlap(measured.bar, measured.word)).toBe(false);
  expect(measured.bar.bottom).toBeLessThanOrEqual(measured.word.top + 1);
  expect(measured.next.reachable).toBe(true);
  expect(measured.bar.left).toBeGreaterThanOrEqual(0);
  expect(measured.bar.top).toBeGreaterThanOrEqual(0);
  expect(measured.bar.right).toBeLessThanOrEqual(measured.viewport.width);
  expect(measured.bar.bottom).toBeLessThanOrEqual(measured.viewport.height);
  expect(measured.bar.left).toBeGreaterThanOrEqual(measured.content.left);
  expect(measured.bar.top).toBeGreaterThanOrEqual(measured.content.top);
  expect(measured.bar.right).toBeLessThanOrEqual(measured.content.right);
  expect(measured.bar.bottom).toBeLessThanOrEqual(measured.content.bottom);
  return measured;
}

export async function checkUnsureWordJumps(
  page: Page,
  projectPath: string,
  name: string,
  theme: Theme,
): Promise<void> {
  await page.route(
    (url) => new URL(url).pathname === "/api/document/state",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      lower((body.project ?? body.patch) as Record<string, unknown>);
      await route.fulfill({ response, json: body });
    },
  );
  await openProject(page, projectPath);
  await setTheme(page, theme);
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
  let last: Awaited<ReturnType<typeof recordPlacement>> | null = null;
  for (const [index, [key, word]] of stops.entries()) {
    await next.click();
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute("data-word-key", key);
    await expect(selected).toContainText(word);
    await expect(selected).toBeInViewport();
    last = await recordPlacement(page, `${name}-${index}`);
  }
  expect(last?.nextLine?.key).toBeTruthy();
  if (!last?.nextLine?.key)
    throw new Error("The fixture has no subsequent Script line");
  const nextLine = page.locator(
    `.sys-script-word[data-word-key="${last.nextLine.key}"]`,
  );
  await nextLine.click({ modifiers: ["Shift"] });
  await expect(nextLine).toHaveAttribute("data-selected");
  await expectPageAxeClean(page);
}
