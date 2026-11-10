const UNTITLED_CLIP = "Untitled clip";

export const shownTitle = (title: string | null | undefined) =>
  title?.trim() || UNTITLED_CLIP;
