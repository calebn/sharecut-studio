import { test } from "@playwright/test";
import { withAppearance } from "./theme";
import {
  exerciseClipInspectorAffordances,
  exerciseInviteAffordances,
} from "./touchAffordances";

test.use({ hasTouch: true });

const cases = [
  { width: 360, height: 800 },
  { width: 667, height: 360 },
  { width: 820, height: 1180 },
  { width: 1440, height: 900 },
] as const;

for (const { cell: viewport, theme, reducedMotion } of withAppearance(cases)) {
  const appearance = `${viewport.width}x${viewport.height}, ${theme}, reduced motion ${reducedMotion}`;
  test(`Invite touch affordances ${appearance}`, async ({ page }) => {
    await exerciseInviteAffordances({
      page,
      viewport,
      theme,
      reducedMotion,
      owner: { suite: "main" },
    });
  });
  test(`clip Inspector touch affordances ${appearance}`, async ({ page }) => {
    await exerciseClipInspectorAffordances({
      page,
      viewport,
      theme,
      reducedMotion,
      owner: { suite: "main" },
    });
  });
}

test("sheet affordances remain available at 200% text scale", async ({
  page,
}) => {
  await exerciseInviteAffordances({
    page,
    viewport: {
      width: 360,
      height: 800,
      textScale: true,
      requireBodyOverflow: true,
    },
    theme: "light",
    reducedMotion: true,
    owner: { suite: "main" },
  });
});

test("clip Inspector affordances remain available at 200% text scale", async ({
  page,
}) => {
  await exerciseClipInspectorAffordances({
    page,
    viewport: {
      width: 360,
      height: 800,
      textScale: true,
      requireBodyOverflow: true,
    },
    theme: "light",
    reducedMotion: true,
    owner: { suite: "main" },
  });
});
