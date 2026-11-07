import { composeStories } from "@storybook/react-vite";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cdp, page } from "vitest/browser";

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
const ENABLED_CLOSED =
  '[aria-expanded="false"]:not([aria-haspopup]):not(:disabled):not([aria-disabled="true"])';
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
  ".sys-scrub-value",
  ".sys-scrub-unit",
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
let disclosureRoot: Root | undefined;
const originalMedia = {
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  light: matchMedia("(prefers-color-scheme: light)").matches,
};

beforeEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-color-scheme", value: "light" },
    ],
  });
});

beforeAll(async () => {
  await document.fonts.ready;
});

afterEach(async () => {
  disclosureRoot?.unmount();
  disclosureRoot = undefined;
  host?.remove();
  host = undefined;
  document.documentElement.removeAttribute("data-theme");
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [
      {
        name: "prefers-reduced-motion",
        value: originalMedia.reducedMotion ? "reduce" : "no-preference",
      },
      {
        name: "prefers-color-scheme",
        value: originalMedia.light ? "light" : "dark",
      },
    ],
  });
  expect({
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    light: matchMedia("(prefers-color-scheme: light)").matches,
  }).toEqual(originalMedia);
});

async function wideNodes(
  root: Element,
  context = "overflow fixture",
): Promise<string[]> {
  for (let pass = 0; pass < 6; pass += 1) {
    const closed = [...root.querySelectorAll<HTMLElement>(ENABLED_CLOSED)];
    if (closed.length === 0) break;
    for (const control of closed) {
      if (!root.contains(control) || !control.matches(ENABLED_CLOSED)) continue;
      control.click();
      await expect
        .poll(
          () =>
            !root.contains(control) ||
            control.getAttribute("aria-expanded") !== "false",
          { message: `${context}: disclosure click must settle` },
        )
        .toBe(true);
    }
  }
  expect(
    [...root.querySelectorAll(ENABLED_CLOSED)].map(
      (control) => control.outerHTML,
    ),
    `${context}: enabled disclosures must be expanded before measurement`,
  ).toEqual([]);
  const overflows = () =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth;
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
  it("settles enabled disclosures before measuring and leaves disabled controls alone", async () => {
    await page.viewport(320, 800);
    const enabledClick = vi.fn();
    const disabledClick = vi.fn();
    const ariaDisabledClick = vi.fn();
    function Disclosure() {
      const [expanded, setExpanded] = useState(false);
      return (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => {
              enabledClick();
              setExpanded((value) => !value);
            }}
          >
            Details
          </button>
          <button
            type="button"
            disabled
            aria-expanded="false"
            onClick={disabledClick}
          >
            Disabled details
          </button>
          <button
            type="button"
            aria-disabled="true"
            aria-expanded="false"
            onClick={ariaDisabledClick}
          >
            Unavailable details
          </button>
          {expanded && (
            <span
              className="expanded-overflow-probe"
              style={{ whiteSpace: "nowrap" }}
            >
              Hidden name
            </span>
          )}
        </>
      );
    }
    host = document.createElement("div");
    host.style.width = "6rem";
    document.body.appendChild(host);
    disclosureRoot = createRoot(host);
    disclosureRoot.render(<Disclosure />);
    await expect.poll(() => host?.querySelector("button")).not.toBeNull();

    expect(await wideNodes(host)).toEqual([
      'span.expanded-overflow-probe "Hidden name"',
    ]);
    expect(enabledClick).toHaveBeenCalledOnce();
    expect(disabledClick).not.toHaveBeenCalled();
    expect(ariaDisabledClick).not.toHaveBeenCalled();
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(host.querySelector(".expanded-overflow-probe")?.textContent).toBe(
      "Hidden name",
    );
  });
  it("uses reduced motion and a light color scheme", () => {
    expect({
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      light: matchMedia("(prefers-color-scheme: light)").matches,
    }).toEqual({ reducedMotion: true, light: true });
  });

  it("covers more than 40 stories", () => {
    expect(stories.length).toBeGreaterThan(40);
  });

  for (const className of ["sys-scrub-value", "sys-scrub-unit"]) {
    it(`leaves app-generated ${className} text out of the mutation`, async () => {
      host = document.createElement("div");
      const value = document.createElement("span");
      value.className = className;
      value.style.whiteSpace = "nowrap";
      value.textContent = "24";
      host.appendChild(value);
      document.body.appendChild(host);

      expect(await wideNodes(host)).toEqual([]);
      expect(value.textContent).toBe("24");
    });
  }

  it("detects forced nowrap overflow", async () => {
    await page.viewport(320, 800);
    host = document.createElement("div");
    host.style.width = "6rem";
    const value = document.createElement("span");
    value.className = "overflow-probe";
    value.style.overflowWrap = "anywhere";
    value.style.whiteSpace = "nowrap";
    value.textContent = "24";
    host.appendChild(value);
    document.body.appendChild(host);

    expect(await wideNodes(host)).toEqual(['span.overflow-probe "24"']);
    value.style.whiteSpace = "normal";
    expect(await wideNodes(host)).toEqual([]);
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
        await expect.poll(() => host?.firstElementChild ?? null).not.toBeNull();
        const storyRoot = host.firstElementChild;
        if (!storyRoot) {
          throw new Error(
            `${story.id} at ${width}: missing rendered story root`,
          );
        }
        await expect.element(page.elementLocator(storyRoot)).toBeVisible();
        await document.fonts.ready;
        expect
          .soft(
            await wideNodes(host, `${story.id} at ${width}`),
            `${story.id} at ${width}`,
          )
          .toEqual([]);
        host.remove();
        host = undefined;
      }
    });
  }
});
