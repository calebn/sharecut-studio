import { titleWithShortcut } from "../keymap/registry";

/**
 * Shared by ToolModeToggleView's Comment button and TransportBar's collapsed
 * Comment button, so both read one string. Lives outside ToolModeToggle.tsx
 * (a component file) so exporting it does not break Fast Refresh.
 */
export const commentModeTitle = titleWithShortcut(
  "Comment mode: click/drag ruler to anchor feedback",
  "review.toggleCommentMode",
);
