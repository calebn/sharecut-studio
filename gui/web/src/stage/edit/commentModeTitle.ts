import { titleWithShortcut } from "../../keymap/registry";

/**
 * The Comment button's title. Lives outside ToolModeToggle.tsx (a component
 * file) so exporting it does not break Fast Refresh.
 */
export const commentModeTitle = titleWithShortcut(
  "Toggle comment mode: tap or drag the ruler to set the comment time",
  "review.toggleCommentMode",
);
