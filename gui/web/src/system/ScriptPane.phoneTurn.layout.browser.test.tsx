import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { ScriptPane } from "./ScriptPane";
import { SCRIPT_TURNS } from "./scriptFixtures";

let host: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  document.documentElement.removeAttribute("data-theme");
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

async function render(layout: "desktop" | "phone", width: number) {
  host = document.createElement("div");
  host.style.cssText = `inline-size:${width}px;block-size:34rem;`;
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    createElement(ScriptPane, {
      turns: SCRIPT_TURNS,
      layout,
      onSelect: () => {},
      onSpeaker: () => {},
    }),
  );
  await document.fonts.ready;
  await frame();
  await frame();
  const turn = host.querySelector<HTMLElement>(".sys-script-turn");
  const margin = host.querySelector<HTMLElement>(".sys-script-margin");
  const text = host.querySelector<HTMLElement>(".sys-script-text");
  const avatar = host.querySelector<HTMLElement>(
    ".sys-script-speaker svg, .sys-script-speaker [class*=avatar]",
  );
  if (!turn || !margin || !text) throw new Error("The turn is missing");
  return {
    turn: turn.getBoundingClientRect(),
    margin: margin.getBoundingClientRect(),
    text: text.getBoundingClientRect(),
    avatar: avatar?.getBoundingClientRect(),
  };
}

for (const theme of ["light", "dark"] as const) {
  describe(`turn layout, ${theme}`, () => {
    it("puts the speaker above the text in one column on the phone", async () => {
      await page.viewport(390, 844);
      document.documentElement.setAttribute("data-theme", theme);
      const box = await render("phone", 390);
      expect(box.margin.bottom).toBeLessThanOrEqual(box.text.top + 0.5);
      expect(Math.abs(box.margin.left - box.text.left)).toBeLessThan(0.5);
      expect(box.text.width).toBeGreaterThan(box.turn.width - 1);
      expect(box.avatar?.width).toBe(20);
    });

    it("keeps the speaker in a margin column beside the text on the desktop", async () => {
      await page.viewport(1024, 768);
      document.documentElement.setAttribute("data-theme", theme);
      const box = await render("desktop", 640);
      expect(box.margin.right).toBeLessThanOrEqual(box.text.left + 0.5);
      expect(Math.abs(box.margin.top - box.text.top)).toBeLessThan(2);
    });
  });
}
