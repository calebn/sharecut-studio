import { expect, it } from "vitest";
import { plainError } from "./plainError";

it.each([
  [
    "Refresh failed: set PODCAST_MCP_FFMPEG and PODCAST_MCP_FFPROBE to its bin executables.",
    "Refresh failed. Export diagnostics from the command palette and try again.",
  ],
  [
    "Open failed: /home/ben/episodes/ep1/project.json is unreadable",
    "Open failed. Export diagnostics from the command palette and try again.",
  ],
  [
    "PODCAST_MCP_FFMPEG is not set",
    "Something went wrong. Export diagnostics from the command palette and try again.",
  ],
  ["Delete failed: Unknown clip", "Delete failed: Unknown clip"],
  [
    "Import failed: the file is not audio",
    "Import failed: the file is not audio",
  ],
])("%s", (message, shown) => {
  expect(plainError(message)).toBe(shown);
});
