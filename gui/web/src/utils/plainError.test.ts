import { expect, it } from "vitest";
import { plainError } from "./plainError";

const NEXT = "Export diagnostics from the command palette and try again.";

it.each([
  // Internals go; the first sentence's lead stays, with the next step.
  [
    "Refresh failed: set PODCAST_MCP_FFMPEG and PODCAST_MCP_FFPROBE to its bin executables.",
    `Refresh failed. ${NEXT}`,
  ],
  [
    "Open failed: /home/ben/episodes/ep1/project.json is unreadable",
    `Open failed. ${NEXT}`,
  ],
  ["PODCAST_MCP_FFMPEG is not set", `Something went wrong. ${NEXT}`],
  ["Export failed. See log: C:\\Users\\a\\x.wav", `Export failed. ${NEXT}`],
  ["Restore failed: bleed_restore_changed", `Restore failed. ${NEXT}`],
  [
    "Render failed: 3fa85f64-5717-4562-b3fc-2c963f66afa6 not found",
    `Render failed. ${NEXT}`,
  ],
  ["Traceback (most recent call last): boom", `Something went wrong. ${NEXT}`],
  // A lone path becomes "the file", and later sentences stay.
  [
    "Could not read C:\\Users\\a\\Documents\\ep1.wav. Check the file is not open elsewhere.",
    "Could not read the file. Check the file is not open elsewhere.",
  ],
  [
    "Could not read /home/ben/episodes/ep1.wav. Check the file is not open elsewhere.",
    "Could not read the file. Check the file is not open elsewhere.",
  ],
  [
    "Import failed. PODCAST_MCP_FFMPEG is missing. Install FFmpeg and retry.",
    "Import failed. Install FFmpeg and retry.",
  ],
  ["Could not open /Users/bob/ep1/mix.wav", `Could not open the file. ${NEXT}`],
  ["Could not open ~/Podcasts/out.mp3", `Could not open the file. ${NEXT}`],
  [
    "Could not open ./relative/path/file.json",
    `Could not open the file. ${NEXT}`,
  ],
  // Ordinary words with slashes, acronyms and dates are not internals.
  ["Choose stereo/mono/dual first", "Choose stereo/mono/dual first"],
  ["Use WAV/AIFF/FLAC for export", "Use WAV/AIFF/FLAC for export"],
  ["Recorded on 12/03/2026", "Recorded on 12/03/2026"],
  ["MPEG layer 3 is not supported", "MPEG layer 3 is not supported"],
  ["ASIO and WASAPI are not available", "ASIO and WASAPI are not available"],
  ["FFMPEG is too old", "FFMPEG is too old"],
  ["Check failed: LUFS is out of range", "Check failed: LUFS is out of range"],
  ["Delete failed: Unknown clip", "Delete failed: Unknown clip"],
  [
    "Import failed: the file is not audio",
    "Import failed: the file is not audio",
  ],
  ["Reorder failed: track is locked.", "Reorder failed: track is locked."],
  [
    "Can't undo: the project changed since.",
    "Can't undo: the project changed since.",
  ],
])("%s", (message, shown) => {
  expect(plainError(message)).toBe(shown);
});
