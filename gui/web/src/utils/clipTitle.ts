const UNTITLED_CLIP = "Untitled clip";

/** What a page shows for a clip title: an empty one reads as the project's untitled clip. */
export const shownTitle = (title: string | null | undefined) =>
  title?.trim() || UNTITLED_CLIP;
