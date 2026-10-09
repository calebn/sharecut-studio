import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { setTheme } from "./theme";

const semanticTokens = [
  "--color-border",
  "--color-border-strong",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-unmapped",
  "--color-accent",
  "--color-accent-fg",
  "--color-accent-solid",
  "--color-accent-on-solid",
  "--color-badge-bg",
  "--color-badge-fg",
  "--color-selection",
  "--color-warning",
  "--color-warning-subtle",
  "--color-warning-muted",
  "--color-warning-strong",
  "--color-danger",
  "--color-danger-muted",
  "--color-danger-subtle",
  "--color-success",
  "--color-success-subtle",
  "--color-success-muted",
  "--color-success-strong",
  "--color-success-solid",
  "--color-clip-dialogue-0",
  "--color-clip-dialogue-1",
  "--color-clip-dialogue-2",
  "--color-clip-music",
  "--color-clip-sfx",
  "--color-presence-0",
  "--color-presence-1",
  "--color-presence-2",
  "--color-presence-3",
  "--color-presence-4",
  "--color-presence-5",
  "--color-presence-6",
  "--color-presence-7",
  "--color-pending-edit",
  "--color-pending-edit-stripe",
  "--color-pending-mute",
  "--color-applied-edit",
  "--color-envelope-line",
  "--color-marker",
  "--color-social-marker",
  "--color-comment-marker",
  "--color-clipping-region",
  "--color-scrim",
  "--color-shadow",
  "--color-shadow-soft",
] as const;

test("semantic theme roles preserve browser values in both themes", async ({
  page,
}) => {
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();

  const receipt: Record<string, unknown> = {};
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    receipt[theme] = await page.evaluate((tokens) => {
      const style = getComputedStyle(document.documentElement);
      const values = Object.fromEntries(
        tokens.map((token) => [token, style.getPropertyValue(token).trim()]),
      );
      const representatives = [
        ".daw-shell",
        ".transport",
        ".timeline-area",
      ].map((selector) => {
        const element = document.querySelector(selector);
        if (!element)
          throw new Error(`Missing rendered representative ${selector}`);
        const computed = getComputedStyle(element);
        return [
          selector,
          {
            color: computed.color,
            backgroundColor: computed.backgroundColor,
            borderColor: computed.borderColor,
            backgroundImage: computed.backgroundImage,
          },
        ];
      });
      return { values, representatives };
    }, semanticTokens);
  }

  for (const [theme, captured] of Object.entries(receipt)) {
    const values = (captured as { values: Record<string, string> }).values;
    for (const [token, value] of Object.entries(values)) {
      expect(value, `${theme} ${token}`).not.toBe("");
    }
  }

  const output = process.env.THEME_ALIAS_RECEIPT;
  if (output) fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
});
