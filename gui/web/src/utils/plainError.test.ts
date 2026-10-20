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
  [
    "Export failed. See log: C:\\Users\\a\\x.wav",
    "Export failed. Export diagnostics from the command palette and try again.",
  ],
  [
    "Save failed: set FFMPEG or PATH first",
    "Save failed. Export diagnostics from the command palette and try again.",
  ],
  [
    "Restore failed: bleed_restore_changed",
    "Restore failed. Export diagnostics from the command palette and try again.",
  ],
  ["Check failed: LUFS is out of range", "Check failed: LUFS is out of range"],
  ["Delete failed: Unknown clip", "Delete failed: Unknown clip"],
  [
    "Import failed: the file is not audio",
    "Import failed: the file is not audio",
  ],
])("%s", (message, shown) => {
  expect(plainError(message)).toBe(shown);
});
