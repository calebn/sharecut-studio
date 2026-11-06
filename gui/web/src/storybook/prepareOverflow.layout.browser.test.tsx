import { composeStories } from "@storybook/react-vite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

/**
 * Real-layout check that no text in Prepare or its System parts pushes the
 * page sideways. Every text node of every story, one at a time, becomes 300
 * unbroken characters, after every collapsed control has been opened. Words
 * the app writes itself (labels, buttons, headings, counts, reasons) are left
 * as they are; names, titles, file names, details and causes come from the
 * person or the files, so those are stretched, and so are the speaker and
 * term chips and the text of each "Hear <name>" button. Skipped: buttons other
 * than Hear, labels, kbd, output, the class-less spans of the target control
 * and of the On/Off switch text, and the classes listed in APP_COPY.
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
  "button:not(.sys-source-hear)",
  "kbd",
  "output",
  "span:not([class]):not(.sys-chip > span)",
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

type ComposedStory = {
  run: (options: {
    canvasElement: HTMLElement;
    globals: Record<string, unknown>;
  }) => Promise<void>;
  id: string;
};

const modules = import.meta.glob("../**/*.stories.{ts,tsx}", {
  eager: true,
}) as Record<string, Record<string, unknown>>;

const stories: ComposedStory[] = Object.values(modules)
  .flatMap(
    (mod) =>
      Object.values(
        composeStories(mod as never) as Record<string, unknown>,
      ) as unknown as ComposedStory[],
  )
  .filter((story) => PREFIXES.some((prefix) => story.id.startsWith(prefix)));

let host: HTMLElement | undefined;

beforeAll(async () => {
  await document.fonts.ready;
});

afterEach(() => {
  host?.remove();
  host = undefined;
  document.documentElement.removeAttribute("data-theme");
});

function wideNodes(root: Element): string[] {
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
      !node.parentElement?.matches(APP_COPY)
    ) {
      nodes.push(node);
    }
  }
  const found: string[] = [];
  if (overflows()) found.push("before any change");
  for (const node of nodes) {
    const before = node.data;
    node.data = LONG;
    if (overflows()) {
      const parent = node.parentElement;
      found.push(
        `${parent?.tagName.toLowerCase()}.${parent?.className} "${before.slice(0, 40)}"`,
      );
    }
    node.data = before;
  }
  return found;
}

describe("Prepare text never scrolls the page sideways", () => {
  it("covers more than 40 stories", () => {
    expect(stories.length).toBeGreaterThan(40);
  });

  for (const width of [320, 360]) {
    it(`at ${width}`, { timeout: 240_000 }, async () => {
      await page.viewport(width, 800);
      for (const story of stories) {
        host = document.createElement("div");
        host.id = "storybook-root";
        host.style.padding = "1rem";
        document.body.appendChild(host);
        await story.run({ canvasElement: host, globals: { theme: "light" } });
        await document.fonts.ready;
        expect.soft(wideNodes(host), `${story.id} at ${width}`).toEqual([]);
        host.remove();
        host = undefined;
      }
    });
  }
});
