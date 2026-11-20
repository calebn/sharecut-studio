type TaggedStory = { tags?: readonly string[] };

export const SHELL_TITLES: readonly string[] = ["Stages/Edit/Frame"];

export function isStorybookOnly(story: TaggedStory): boolean {
  return story.tags?.includes("storybook-only") ?? false;
}

function parseShard(raw: string | undefined): { index: number; total: number } {
  if (raw === undefined || raw === "") return { index: 1, total: 1 };
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || index < 1 || index > total) {
    throw new Error(
      `VITE_STORY_SHARD must be i/n with 1 <= i <= n, got "${raw}"`,
    );
  }
  return { index, total };
}

export function selectBrowserStoryShard<T extends TaggedStory>(
  stories: readonly T[],
  rawShard: string | undefined,
): T[] {
  const { index, total } = parseShard(rawShard);
  return stories
    .filter((story) => !isStorybookOnly(story))
    .filter((_, position) => position % total === index - 1);
}
