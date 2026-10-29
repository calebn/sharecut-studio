import { expect, test } from "@playwright/test";
import { FROZEN } from "../src/test/frozenTokens";
import { storyUrl } from "./storyUrl";

/**
 * tokens.test.ts argues the old tokens are unchanged by reading the
 * declarations. This resolves each simple length, duration, number and z-index
 * in a real page and compares it with what the declaration says.
 */

const REM = 16;

type Probe = { name: string; kind: "length" | "time" | "number"; want: number };

function probes(): Probe[] {
  const out: Probe[] = [];
  for (const [name, values] of FROZEN) {
    // Tokens with two declarations keep the desktop one first.
    const value = values[0];
    let m = /^(-?[\d.]+)rem$/.exec(value);
    if (m) {
      out.push({ name, kind: "length", want: Number(m[1]) * REM });
      continue;
    }
    m = /^(-?[\d.]+)px$/.exec(value);
    if (m) {
      out.push({ name, kind: "length", want: Number(m[1]) });
      continue;
    }
    m = /^([\d.]+)(ms|s)$/.exec(value);
    if (m) {
      out.push({
        name,
        kind: "time",
        want: Number(m[1]) * (m[2] === "s" ? 1000 : 1),
      });
      continue;
    }
    if (/^[\d.]+$/.test(value)) {
      out.push({ name, kind: "number", want: Number(value) });
    }
  }
  return out;
}

for (const theme of ["light", "dark"] as const) {
  test(`the frozen size, motion and layer tokens resolve to their declared values in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({
      colorScheme: theme,
      reducedMotion: "no-preference",
    });
    await page.goto(storyUrl("system-cover--empty", { theme }));
    await expect(page.getByRole("heading").first()).toBeVisible();
    const list = probes();
    expect(list.length).toBeGreaterThan(60);
    const measured = await page.evaluate((items) => {
      const box = document.createElement("div");
      box.style.cssText =
        "position:absolute;visibility:hidden;font-size:16px;transition-property:opacity";
      document.body.append(box);
      const got = items.map((item) => {
        box.style.inlineSize = "";
        box.style.transitionDuration = "";
        box.style.zIndex = "";
        box.style.opacity = "";
        let value = Number.NaN;
        const ref = `var(${item.name})`;
        if (item.kind === "length") {
          box.style.inlineSize = ref;
          value = Number.parseFloat(getComputedStyle(box).inlineSize);
        } else if (item.kind === "time") {
          box.style.transitionDuration = ref;
          value =
            Number.parseFloat(getComputedStyle(box).transitionDuration) * 1000;
        } else if (item.name.startsWith("--z-")) {
          box.style.zIndex = ref;
          value = Number.parseFloat(getComputedStyle(box).zIndex);
        } else {
          box.style.opacity = ref;
          value = Number.parseFloat(getComputedStyle(box).opacity);
        }
        return { name: item.name, value };
      });
      box.remove();
      return got;
    }, list);
    const wrong = measured
      .map((entry, i) => ({ ...entry, want: list[i].want }))
      .filter((entry) => Math.abs(entry.value - entry.want) > 0.01);
    expect(wrong).toEqual([]);
  });
}
