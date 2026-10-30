import type { TranscriptExportResult } from "../../api";
import type {
  TranscriptFile,
  TranscriptPreviewState,
} from "../../stages/deliver/transcriptLogic";

const PRESENCE_COLORS = 8;

/** The preview a dry run gives; an episode with no turns left reads as all cut. */
export function previewStateOf(
  result: TranscriptExportResult,
): TranscriptPreviewState {
  if (result.turns === 0) return { kind: "allCut" };
  const colors = new Map<string, number>();
  return {
    kind: "ready",
    preview: {
      turns: result.turns,
      durationSec: result.duration_sec,
      language: result.language,
      cueSample: result.cue_sample,
      shown: result.preview.map((turn) => {
        if (!colors.has(turn.speaker)) {
          colors.set(turn.speaker, colors.size % PRESENCE_COLORS);
        }
        return {
          speaker: turn.speaker,
          startSec: turn.start_sec,
          text: turn.text,
          colorIndex: colors.get(turn.speaker) ?? 0,
        };
      }),
    },
  };
}

export function transcriptFilesOf<F extends TranscriptFile>(
  files: readonly F[],
): TranscriptFile[] {
  return files.map(({ name, bytes, format, current }) => ({
    name,
    bytes,
    format,
    current,
  }));
}
