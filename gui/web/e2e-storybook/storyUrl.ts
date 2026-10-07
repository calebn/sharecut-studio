export type StoryTheme = "light" | "dark";

interface StoryUrlOptions {
  theme: StoryTheme;
  viewMode?: "story" | "docs";
  embed?: boolean;
}

/**
 * Every Storybook spec opens story frames through this builder. The Storybook
 * a11y addon otherwise runs its own axe instance in each story frame and
 * replaces `window.axe` when it loads, so a spec's own scan that overlaps it
 * fails with "Axe is already running" (#1120). `a11y.manual:!true` keeps the
 * addon idle in the frame; it still runs in the Storybook UI.
 */
export function storyUrl(
  id: string,
  { theme, viewMode = "story", embed }: StoryUrlOptions,
): string {
  const globals = `theme:${theme};a11y.manual:!true`;
  const embedParam = embed === undefined ? "" : `&embed=${embed}`;
  return `/iframe.html?id=${id}&viewMode=${viewMode}&globals=${globals}${embedParam}`;
}
