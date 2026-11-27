import {
  DUCKING_AGAIN_LABEL,
  DUCKING_CHECKING,
  DUCKING_CURRENT,
  DUCKING_LABEL,
  DUCKING_STALE,
  DUCKING_UNREACHABLE,
  duckingReadyLine,
  duckingRefusalLine,
} from "../../commands/duckingCopy";
import { CommandButton } from "../../ui";
import { note } from "./sheetNote";
import type { DuckingPreview } from "./useDuckingPreview";

function statusOf(preview: DuckingPreview): string {
  switch (preview.kind) {
    case "checking":
      return DUCKING_CHECKING;
    case "unreachable":
      return DUCKING_UNREACHABLE;
    case "refused":
      return preview.message;
    case "none":
    case "silent":
    case "changed":
      return duckingRefusalLine(preview.kind);
    case "current":
      return DUCKING_CURRENT;
    case "stale":
      return DUCKING_STALE;
    case "ready":
      return duckingReadyLine(preview.plan);
  }
}

function blockerOf(
  preview: DuckingPreview,
  busyReason: string | undefined,
): string | undefined {
  if (busyReason) return busyReason;
  switch (preview.kind) {
    case "checking":
      return DUCKING_CHECKING;
    case "refused":
      return preview.message;
    case "none":
    case "silent":
    case "changed":
      return duckingRefusalLine(preview.kind);
    case "current":
      return DUCKING_CURRENT;
    default:
      return undefined;
  }
}

/** The track inspector's Duck music under speech: what the dry run found, and the action. */
export function duckingRows(
  preview: DuckingPreview,
  busyReason: string | undefined,
) {
  const planToken = "plan" in preview ? preview.plan.planToken : undefined;
  return [
    {
      id: "duck",
      label: "Ducking",
      control: note(statusOf(preview), "status"),
    },
    {
      id: "duckAction",
      control: (
        <CommandButton
          commandId="track.duckUnderSpeech"
          className="track-sheet-action"
          args={planToken === undefined ? {} : { planToken }}
          disabledReason={blockerOf(preview, busyReason)}
        >
          {preview.kind === "stale" ? DUCKING_AGAIN_LABEL : DUCKING_LABEL}
        </CommandButton>
      ),
    },
  ];
}
