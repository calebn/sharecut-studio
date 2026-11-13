import { composeStories } from "@storybook/react-vite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import * as stories from "./ReviewHost.stories";

const { GuestCommenterTranscriptPending, GuestCommenterTranscriptFailure } =
  composeStories(stories);
const cases = [
  ["pending", GuestCommenterTranscriptPending],
  ["failed", GuestCommenterTranscriptFailure],
] as const;
let host: HTMLElement | undefined;

beforeAll(async () => {
  await document.fonts.ready;
});

afterEach(() => {
  host?.remove();
  host = undefined;
  document.documentElement.removeAttribute("data-theme");
});

async function expectWholeControl(element: HTMLElement) {
  const ratio = await new Promise<number>((resolve) => {
    const observer = new IntersectionObserver(([entry]) => {
      observer.disconnect();
      resolve(entry.intersectionRatio);
    });
    observer.observe(element);
  });
  expect(ratio).toBeCloseTo(1, 3);
  const rect = element.getBoundingClientRect();
  for (const [x, y] of [
    [rect.left + rect.width / 2, rect.top + 2],
    [rect.right - 2, rect.top + rect.height / 2],
    [rect.left + rect.width / 2, rect.bottom - 2],
    [rect.left + 2, rect.top + rect.height / 2],
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
  ]) {
    const painted = document.elementFromPoint(x, y);
    expect(painted === element || element.contains(painted)).toBe(true);
  }
}

for (const theme of ["light", "dark"] as const) {
  describe(`compact guest transcript feedback in ${theme}`, () => {
    for (const [state, story] of cases) {
      it(`keeps the Comment field and send arrow reachable while ${state}`, async () => {
        await page.viewport(320, 568);
        host = document.createElement("div");
        host.id = "storybook-root";
        document.body.appendChild(host);
        await story.run({ canvasElement: host, globals: { theme } });
        await document.fonts.ready;
        expect(document.documentElement.dataset.theme).toBe(theme);
        const open = host.querySelector<HTMLButtonElement>(
          ".sys-listen-dock-comment",
        );
        if (!open) throw new Error("The dock's Comment button is missing");
        open.click();
        const field = await vi.waitFor(() => {
          const found = host?.querySelector<HTMLTextAreaElement>(
            '.rv-compose textarea[aria-label="Comment"]',
          );
          if (!found) throw new Error("The Comment field is missing");
          return found;
        });
        const send = field
          .closest(".sys-composer")
          ?.querySelector<HTMLElement>(".sys-composer-submit");
        if (!send) throw new Error("The comment send arrow is missing");
        expect(field.readOnly).toBe(false);
        await expectWholeControl(field);
        await expectWholeControl(send);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
      }, 10_000);
    }
  });
}
