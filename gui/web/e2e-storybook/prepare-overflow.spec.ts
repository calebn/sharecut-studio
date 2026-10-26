import { expect, test } from "@playwright/test";
import { storyUrl } from "./storyUrl";

/**
 * Real-layout check that no text in Prepare or its System parts pushes the
 * page sideways. Every text node of every story, one at a time, becomes 300
 * unbroken characters, after every collapsed control has been opened. Words
 * the app writes itself (labels, buttons, headings, counts, reasons) are left
 * as they are; names, titles, file names, details and causes come from the
 * person or the files, so those are stretched.
 */

const PREFIXES = [
  "stages-prepare-",
  "system-statuslist--",
  "system-sourcecard--",
  "system-sessiongroup--",
];
const LONG = "Q".repeat(300);
const APP_COPY = [
  "label",
  "button",
  "kbd",
  "output",
  "span:not([class])",
  ".sys-prepare-title",
  ".sys-prepare-subtitle",
  ".sys-prepare-label",
  ".sys-prepare-note",
  ".sys-group-stats",
  ".sys-group-status-text",
  ".sys-group-empty",
  ".sys-handoff-label",
  ".sys-handoff-reason",
  ".sys-target-reason",
  ".sys-start-title",
  ".sys-start-line",
  ".sys-chips-note",
  ".sys-chips-count",
  ".sys-stepper-reason",
  ".sys-adv-value",
  ".sys-adv-help",
  ".sys-adv-reason",
  ".ui-toast-message",
  ".ui-field-hint:not(.sys-source *)",
].join(",");

interface IndexEntry {
  id: string;
  type: string;
}

async function storyIds(
  request: import("@playwright/test").APIRequestContext,
): Promise<string[]> {
  const response = await request.get("/index.json");
  const index = (await response.json()) as {
    entries: Record<string, IndexEntry>;
  };
  return Object.values(index.entries)
    .filter(
      (entry) =>
        entry.type === "story" &&
        PREFIXES.some((prefix) => entry.id.startsWith(prefix)),
    )
    .map((entry) => entry.id);
}

for (const width of [320, 360]) {
  test(`Prepare text never scrolls the page sideways at ${width}`, async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const ids = await storyIds(request);
    expect(ids.length).toBeGreaterThan(40);
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    for (const id of ids) {
      await page.goto(storyUrl(id, { theme: "light" }));
      await page.locator("#storybook-root > *").first().waitFor();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(200);
      const wide = await page.evaluate(
        ({ long, copy }) => {
          const root = document.querySelector("#storybook-root");
          if (!root) return ["no root"];
          for (let pass = 0; pass < 6; pass += 1) {
            const closed = [
              ...root.querySelectorAll<HTMLElement>(
                '[aria-expanded="false"]:not([aria-haspopup])',
              ),
            ];
            if (closed.length === 0) break;
            for (const control of closed) control.click();
          }
          const overflows = () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth;
          const nodes: Text[] = [];
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            const tag = node.parentElement?.tagName;
            if (
              node.data.trim() &&
              tag !== "SCRIPT" &&
              tag !== "STYLE" &&
              !node.parentElement?.matches(copy)
            ) {
              nodes.push(node);
            }
          }
          const found: string[] = [];
          if (overflows()) found.push("before any change");
          for (const node of nodes) {
            const before = node.data;
            node.data = long;
            if (overflows()) {
              const parent = node.parentElement;
              found.push(
                `${parent?.tagName.toLowerCase()}.${parent?.className} "${before.slice(0, 40)}"`,
              );
            }
            node.data = before;
          }
          return found;
        },
        { long: LONG, copy: APP_COPY },
      );
      expect.soft(wide, `${id} at ${width}`).toEqual([]);
    }
  });
}
